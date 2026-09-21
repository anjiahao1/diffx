import { useState, useEffect, useRef } from 'react'

export interface BinaryFileInfo {
  path: string
  type: 'added' | 'deleted' | 'changed' | 'untracked'
}

export interface RepoMeta {
  relPath: string
  branch: string
}

interface DiffData {
  patch: string
  repoName: string
  branch: string
  customMode: boolean
  binaryFiles: BinaryFileInfo[]
  tabSizeMap: Record<string, number>
  untrackedFiles: string[]
  repos?: RepoMeta[]
  commitMessage?: string | null
}

export interface DiffOptions {
  staged: boolean
  untracked: boolean
}

// Per-commit view: `commit` switches /api/diff to that commit's patch;
// `repo` selects the owning repo in workspace mode.
export interface DiffView {
  commit?: string
  repo?: string
}

export function useDiff(options: DiffOptions, view?: DiffView) {
  const [data, setData] = useState<DiffData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Which view the current `data` answers (the request in flight when it was
  // set). During a view switch the previous response stays rendered (no white
  // flash) but is stale: consumers can tell via `viewMismatch`.
  const dataViewRef = useRef<DiffView | undefined>(undefined)

  useEffect(() => {
    setLoading(true)
    setError(null)

    const params = new URLSearchParams({
      staged: String(options.staged),
      untracked: String(options.untracked),
    })
    if (view?.commit) params.set('commit', view.commit)
    if (view?.repo) params.set('repo', view.repo)

    fetch(`/api/diff?${params}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then((json) => {
        dataViewRef.current = view
        setData(json)
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false))
  }, [options.staged, options.untracked, view?.commit, view?.repo])

  return {
    patch: data?.patch ?? null,
    repoName: data?.repoName ?? '',
    branch: data?.branch ?? '',
    customMode: data?.customMode ?? false,
    binaryFiles: data?.binaryFiles ?? [],
    tabSizeMap: data?.tabSizeMap ?? {},
    untrackedFiles: data?.untrackedFiles ?? [],
    repos: data?.repos,
    commitMessage: data?.commitMessage ?? null,
    // True while `data` answers a different view than the current one (a
    // view switch is in flight); commit-scoped data must not be used then.
    viewMismatch:
      !!view &&
      (dataViewRef.current?.commit !== view.commit || dataViewRef.current?.repo !== view.repo),
    loading,
    error,
  }
}
