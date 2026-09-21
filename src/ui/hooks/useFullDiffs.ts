import { useEffect, useRef, useState, useCallback } from 'react'
import { processFile } from '@pierre/diffs'
import type { FileDiffMetadata } from '@pierre/diffs'

const ZERO_OID = /^0+$/

export function fileKey(file: FileDiffMetadata): string {
  return `${file.name}\0${file.prevObjectId ?? ''}\0${file.newObjectId ?? ''}`
}

// Derive the new-file path the same way @pierre/diffs builds `file.name`: from
// the `+++ b/<path>` header (FILENAME_HEADER_REGEX_GIT). The `diff --git` line
// is ambiguous for paths containing ` b/`, but this header is not.
function parseNewPath(chunk: string): string | null {
  const match = chunk.match(/^\+\+\+ [ab]\/([^\t\r\n]+)/m)
  return match ? match[1].trim() : null
}

// Map each per-file patch chunk by name + blob oids so it can be re-processed
// with full file contents. Keyed on oids too because the same file can appear
// twice (staged + unstaged chunks).
function buildChunkMap(patch: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const chunk of patch.split(/^(?=diff --git )/m)) {
    const name = parseNewPath(chunk)
    if (!name) continue
    const indexMatch = chunk.match(/^index ([0-9a-f]+)\.\.([0-9a-f]+)/m)
    const key = `${name}\0${indexMatch?.[1] ?? ''}\0${indexMatch?.[2] ?? ''}`
    if (!map.has(key)) map.set(key, chunk)
  }
  return map
}

// The fetched contents can diverge from the patch (e.g. the worktree was
// edited after the diff was captured — for unstaged changes the worktree blob
// is usually not in the object database, so the server falls back to reading
// the file from disk). Compare every hunk line from the patch against the
// full contents at the positions the hunk headers claim; reject on mismatch
// so expansion never renders code the displayed patch wasn't built from.
function contentsMatchHunks(partial: FileDiffMetadata, full: FileDiffMetadata): boolean {
  const norm = (line: string | undefined) => (line ?? '\0').replace(/\r?\n$/, '')
  for (const hunk of partial.hunks) {
    for (let i = 0; i < hunk.additionCount; i++) {
      if (norm(partial.additionLines[hunk.additionLineIndex + i]) !== norm(full.additionLines[hunk.additionStart - 1 + i])) {
        return false
      }
    }
    for (let i = 0; i < hunk.deletionCount; i++) {
      if (norm(partial.deletionLines[hunk.deletionLineIndex + i]) !== norm(full.deletionLines[hunk.deletionStart - 1 + i])) {
        return false
      }
    }
  }
  return true
}

/**
 * Upgrades patch-parsed (partial) file diffs to full diffs by fetching the
 * complete old/new file contents, which enables hunk context expansion.
 * Returns a map from `fileKey(file)` to the upgraded metadata.
 */
export function useFullDiffs(patch: string | null, files: FileDiffMetadata[], options: { staged: boolean; untracked: boolean; view?: { commit?: string; repo?: string } }) {
  const [fullFiles, setFullFiles] = useState<Map<string, FileDiffMetadata>>(() => new Map())
  const requested = useRef(new Set<string>())
  const patchRef = useRef(patch)
  const view = options.view
  // Responses arrive one file at a time; committing each to state re-renders
  // the whole virtualized diff. Coalesce: one setState per animation frame,
  // so a large patch doesn't freeze the main thread on N sequential renders.
  const pending = useRef(new Map<string, FileDiffMetadata>())
  const rafId = useRef(0)
  const flush = useCallback(() => {
    rafId.current = 0
    if (pending.current.size === 0) return
    const batch = pending.current
    pending.current = new Map()
    setFullFiles((prev) => {
      const next = new Map(prev)
      for (const [k, v] of batch) next.set(k, v)
      return next
    })
  }, [])

  useEffect(() => {
    if (patchRef.current !== patch) {
      patchRef.current = patch
      requested.current = new Set()
      pending.current.clear()
      if (rafId.current) cancelAnimationFrame(rafId.current)
      rafId.current = 0
      setFullFiles(new Map())
    }
    if (!patch) return

    const chunkMap = buildChunkMap(patch)
    for (const file of files) {
      if (!file.isPartial || file.hunks.length === 0) continue
      if (file.type !== 'change' && file.type !== 'rename-changed') continue
      const prevOid = file.prevObjectId
      if (!prevOid || ZERO_OID.test(prevOid) || !file.newObjectId) continue
      const key = fileKey(file)
      if (requested.current.has(key)) continue
      const chunk = chunkMap.get(key)
      if (!chunk) continue
      requested.current.add(key)

      const params = new URLSearchParams({
        path: file.name,
        oldOid: prevOid,
        newOid: file.newObjectId ?? '',
        staged: String(options.staged),
        untracked: String(options.untracked),
      })
      // The server re-generates the diff to validate the oids, so it must
      // see the same view (aggregate vs per-commit) as the patch being shown.
      if (view?.commit) params.set('commit', view.commit)
      if (view?.repo) params.set('repo', view.repo)
      fetch(`/api/file-versions?${params}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data: { old: string; new: string } | null) => {
          if (!data || patchRef.current !== patch) return
          const upgraded = processFile(chunk, {
            cacheKey: `full:${key}`,
            oldFile: { name: file.prevName ?? file.name, contents: data.old },
            newFile: { name: file.name, contents: data.new },
          })
          if (!upgraded || upgraded.isPartial || !contentsMatchHunks(file, upgraded)) return
          pending.current.set(key, upgraded)
          if (!rafId.current) rafId.current = requestAnimationFrame(flush)
        })
        .catch(() => {})
    }

    return () => {
      if (rafId.current) {
        cancelAnimationFrame(rafId.current)
        rafId.current = 0
      }
    }
  }, [patch, files, options.staged, options.untracked, view?.commit, view?.repo, flush])

  return fullFiles
}
