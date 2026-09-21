import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { basename, join, extname, resolve } from 'node:path'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { GIT_CONFIG, getGitDiff, getCustomGitDiff, getCommitPatch, getCommitMessage, getRepoRoot, getRepoName, getBranchName, getFileContent, getBlobContent, getWorktreeFileContent, isImageFile, getTabSizeForFiles, getUntrackedFilePaths } from './git.js'
import { getRepoPatch, getRepoCommits, stripPrefix, prefixPatch } from './workspace.js'
import type { RepoCommits } from './workspace.js'
import { ReviewCache, PersistedCommentStore } from './patchsetCache.js'
import { loadSettings, saveSettings } from './settings.js'
import { InMemoryCommentStore } from './comments.js'
import type { CommentStore } from './comments.js'
import { isSafePath } from './path.js'

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
}

export interface BinaryFileInfo {
  path: string
  type: 'added' | 'deleted' | 'changed' | 'untracked'
}

function parseFilePaths(patch: string): string[] {
  const paths = new Set<string>()
  for (const line of patch.split('\n')) {
    const match = line.match(/^diff --git a\/.+ b\/(.+)$/)
    if (match) paths.add(match[1])
  }
  return [...paths]
}

function parseBinaryFiles(patch: string, untrackedFiles?: string[]): BinaryFileInfo[] {
  const binaryFiles: BinaryFileInfo[] = []
  const lines = patch.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.startsWith('Binary files ') || !line.includes(' differ')) continue

    // Find the file path from the preceding diff --git line
    let filePath = ''
    for (let j = i - 1; j >= 0; j--) {
      const match = lines[j].match(/^diff --git a\/.+ b\/(.+)$/)
      if (match) {
        filePath = match[1]
        break
      }
    }
    if (!filePath) continue

    // Determine change type from surrounding lines
    let changeType: BinaryFileInfo['type'] = 'changed'
    for (let j = i - 1; j >= 0; j--) {
      if (lines[j].startsWith('diff --git')) break
      if (lines[j].startsWith('new file mode')) {
        changeType = 'added'
        break
      }
      if (lines[j].startsWith('deleted file mode')) {
        changeType = 'deleted'
        break
      }
    }

    if (changeType === 'added' && untrackedFiles?.includes(filePath)) {
      changeType = 'untracked'
    }
    binaryFiles.push({ path: filePath, type: changeType })
  }
  return binaryFiles
}

function diffContainsFileVersion(patch: string, path: string, oldOid: string, newOid: string): boolean {
  for (const chunk of patch.split(/^(?=diff --git )/m)) {
    // Match the new-file path from the `+++ b/<path>` header (as the client
    // does); the `diff --git` line is ambiguous for paths containing ` b/`.
    const nameMatch = chunk.match(/^\+\+\+ [ab]\/([^\t\r\n]+)/m)
    if (!nameMatch || nameMatch[1].trim() !== path) continue
    const indexMatch = chunk.match(/^index ([0-9a-f]+)\.\.([0-9a-f]+)/m)
    if (!indexMatch) continue
    // Real clients echo the patch's (abbreviated) oids back; all-zero oids
    // match zero-for-zero regardless of abbreviation length.
    const oldEq = indexMatch[1] === oldOid || (/^0+$/.test(oldOid) && /^0+$/.test(indexMatch[1]))
    const newEq = indexMatch[2] === newOid || (/^0+$/.test(newOid) && /^0+$/.test(indexMatch[2]))
    if (oldEq && newEq) return true
  }
  return false
}

// Per-file blob oids from a commit patch's index lines — the patchset
// snapshot that lets comments show what changed since they were made.
function extractPatchsetFiles(patch: string): Record<string, { oldOid: string; newOid: string }> {
  const files: Record<string, { oldOid: string; newOid: string }> = {}
  for (const chunk of patch.split(/^(?=diff --git )/m)) {
    const name = chunk.match(/^\+\+\+ [ab]\/([^\t\r\n]+)/m)?.[1]?.trim()
    const oids = chunk.match(/^index ([0-9a-f]+)\.\.([0-9a-f]+)/m)
    if (name && oids) files[name] = { oldOid: oids[1], newOid: oids[2] }
  }
  return files
}

function getRepoRootOrCwd(): string {
  try {
    return getRepoRoot()
  } catch {
    return process.cwd()
  }
}

export interface WorkspaceContext {
  root: string
  repos: string[] // repo paths relative to root, sorted
  repoFilter?: string[]
}

// Workspace repos fan out over git subprocesses. Unbounded Promise.all across
// hundreds of repos becomes a fork storm that saturates the CPU and slows
// every spawn down; a bounded queue keeps effective parallelism near the core
// count. Order-preserving, results indexed like the input.
const REPO_CONCURRENCY = 32

function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  })
  return Promise.all(workers).then(() => results)
}

export function createApp(clientDir: string, customDiffArgs?: string[], commentStore?: CommentStore, workspace?: WorkspaceContext) {
  const app = new Hono()
  const isCustomMode = !!customDiffArgs
  const innerStore: CommentStore = commentStore ?? new InMemoryCommentStore()

  // Review state persists under a key derived from the review root: comments
  // survive restarts, and patchset snapshots anchor commit comments to the
  // blob versions they were made on.
  const cacheRoot = workspace?.root ?? getRepoRootOrCwd()
  const cache = new ReviewCache(cacheRoot)
  for (const persisted of cache.loadComments() ?? []) {
    if (persisted && typeof persisted.id === 'string') innerStore.add(persisted)
  }
  const store: CommentStore = new PersistedCommentStore(innerStore, cache)
  const viewedFiles = new Map<string, string>()

  // Repos selected for review after the --repo filter. Empty filter = all.
  const selectedRepos = workspace
    ? workspace.repos.filter(
        (rel) => !workspace.repoFilter?.length || workspace.repoFilter.some((n) => rel === n || rel.endsWith('/' + n)),
      )
    : []

  // Review-completion signal for the coding-agent workflow: the agent polls
  // GET /api/review-status in the background and acts when done flips true.
  let reviewDone = false
  let reviewUpdatedAt: number | null = null
  const reviewStatus = async () => {
    const comments = await store.getAll()
    let open = 0
    let replied = 0
    let resolved = 0
    for (const c of comments) {
      if (c.status === 'resolved') resolved++
      else if (c.replies?.length > 0) replied++
      else open++
    }
    return { done: reviewDone, updatedAt: reviewUpdatedAt, counts: { open, replied, resolved } }
  }

  app.get('/api/review-status', async (c) => c.json(await reviewStatus()))

  app.post('/api/review-status', async (c) => {
    const body = await c.req.json()
    if (typeof body?.done !== 'boolean') {
      return c.json({ error: 'done must be a boolean' }, 400)
    }
    reviewDone = body.done
    reviewUpdatedAt = Date.now()
    return c.json(await reviewStatus())
  })

  app.get('/api/commits', async (c) => {
    let result: RepoCommits[]
    if (workspace) {
      // per-repo git spawns fan out concurrently; Promise.all keeps repo order
      result = (await mapLimit(selectedRepos, REPO_CONCURRENCY, (rel) => getRepoCommits(join(workspace.root, rel), rel))).filter(
        (rc): rc is RepoCommits => rc !== null,
      )
    } else {
      const rc = await getRepoCommits(process.cwd(), '')
      result = rc ? [rc] : []
    }
    return c.json(result)
  })

  app.get('/api/diff', async (c) => {
    let patch: string
    const staged = c.req.query('staged') === 'true'
    const untracked = c.req.query('untracked') === 'true'
    const commit = c.req.query('commit') || undefined
    const repoQuery = c.req.query('repo') || undefined

    let repoName: string
    let branch: string
    let repos: { relPath: string; branch: string }[] | undefined
    let untrackedFiles: string[]
    let commitMessage: string | null = null

    if (workspace) {
      if (commit && !repoQuery) {
        return c.json({ error: 'repo query param required with commit in workspace mode' }, 400)
      }
      // per-repo git spawns fan out concurrently, bounded by REPO_CONCURRENCY
      const results = await mapLimit(selectedRepos, REPO_CONCURRENCY, async (rel) => {
        // commit view: only the requested repo contributes
        if (commit && rel !== repoQuery) return null
        const repoAbs = join(workspace.root, rel)
        try {
          const repoUntracked = untracked && !commit ? await getUntrackedFilePaths(repoAbs) : []
          const [repoPatch, repoBranch, message] = await Promise.all([
            getRepoPatch({ customDiffArgs, untracked, commit, untrackedList: repoUntracked }, repoAbs),
            getBranchName(repoAbs),
            // commit view only: the owning repo's commit message, for review
            commit && rel === repoQuery ? getCommitMessage(commit, repoAbs) : Promise.resolve(null),
          ])
          if (!repoPatch) return null
          return {
            rel,
            patch: prefixPatch(repoPatch, rel),
            branch: repoBranch,
            untrackedFiles: repoUntracked,
            commitMessage: message,
          }
        } catch (err) {
          // one broken repo must not take down the whole workspace diff
          console.warn(`diffx: skipping repo ${rel}:`, err instanceof Error ? err.message : err)
          return null
        }
      })
      const parts: string[] = []
      repos = []
      const untrackedSet = new Set<string>()
      for (const r of results) {
        if (!r) continue
        parts.push(r.patch)
        repos.push({ relPath: r.rel, branch: r.branch })
        for (const f of r.untrackedFiles) untrackedSet.add(`${r.rel}/${f}`)
        if (r.commitMessage) commitMessage = r.commitMessage
      }
      patch = parts.join('\n')
      repoName = basename(workspace.root)
      branch = ''
      untrackedFiles = [...untrackedSet]
    } else {
      const untrackedList = untracked ? await getUntrackedFilePaths() : undefined
      if (isCustomMode) {
        patch = await getCustomGitDiff(customDiffArgs)
      } else if (commit) {
        patch = await getCommitPatch(commit)
        commitMessage = await getCommitMessage(commit)
      } else {
        patch = await getGitDiff({ staged, untracked, untrackedList })
      }
      repoName = getRepoName()
      branch = await getBranchName()
      untrackedFiles = untrackedList ?? []
    }

    const binaryFiles = parseBinaryFiles(patch, untrackedFiles)
    const filePaths = parseFilePaths(patch)
    const tabSizeMap = getTabSizeForFiles(filePaths, workspace?.root)
    return c.json({ patch, repoName, branch, customMode: isCustomMode, binaryFiles, tabSizeMap, untrackedFiles, ...(repos ? { repos } : {}), ...(commit ? { commitMessage } : {}) })
  })

  app.get('/api/file-content', (c) => {
    const path = c.req.query('path')
    const version = c.req.query('version') as 'old' | 'new'
    if (!path || !version) {
      return c.json({ error: 'Missing path or version' }, 400)
    }
    let content: Buffer | null
    if (workspace) {
      const hit = stripPrefix(path, workspace.repos)
      if (!hit) {
        return c.json({ error: 'File not found' }, 404)
      }
      content = getFileContent(hit.filePath, version, join(workspace.root, hit.repo))
    } else {
      content = getFileContent(path, version)
    }
    if (!content) {
      return c.json({ error: 'File not found' }, 404)
    }
    const ext = extname(path)
    const contentType = MIME_TYPES[ext] || 'application/octet-stream'
    return new Response(new Uint8Array(content), {
      headers: { 'Content-Type': contentType },
    })
  })

  // Full old/new file contents for a diffed file, so the client can build a
  // non-partial diff that supports expanding context around hunks.
  // `oldOid`/`newOid` are blob ids from the patch's `index` line. The diff is
  // regenerated and the requested oids must match its `index` line for the
  // requested path: this keeps arbitrary repository blobs unreachable, and
  // rejects requests whose patch no longer matches the worktree (git recomputes
  // the worktree blob hash on every diff, so any edit changes the new oid).
  app.get('/api/file-versions', async (c) => {
    const path = c.req.query('path')
    const oldOid = c.req.query('oldOid')
    const newOid = c.req.query('newOid')
    if (!path || !oldOid || !newOid) {
      return c.json({ error: 'Missing path or oids' }, 400)
    }
    const staged = c.req.query('staged') === 'true'
    const untracked = c.req.query('untracked') === 'true'
    const commit = c.req.query('commit') || undefined
    const repoQuery = c.req.query('repo') || undefined

    // Regenerate only the owning repo's diff (same range semantics as
    // /api/diff via getRepoPatch) and validate the stripped path against it —
    // same security property as before: the oids must appear in the current
    // patch's index line, keeping arbitrary blobs unreachable.
    let patch: string
    let lookupPath = path
    let repoAbs: string | undefined
    if (workspace) {
      const hit = stripPrefix(path, workspace.repos)
      if (!hit) {
        return c.json({ error: 'File version not in current diff' }, 404)
      }
      repoAbs = join(workspace.root, hit.repo)
      lookupPath = hit.filePath
      patch = await getRepoPatch({ customDiffArgs, untracked, commit: commit && hit.repo === repoQuery ? commit : undefined }, repoAbs)
    } else {
      patch = isCustomMode ? await getCustomGitDiff(customDiffArgs) : commit ? await getCommitPatch(commit) : await getGitDiff({ staged, untracked })
    }
    if (!diffContainsFileVersion(patch, lookupPath, oldOid, newOid)) {
      return c.json({ error: 'File version not in current diff' }, 404)
    }
    // A zero oid is git's `/dev/null` — an absent side (creation/deletion), so
    // its content is empty. A non-zero oid that is missing from the object
    // database is the worktree blob of an unstaged change (git computes its
    // hash without storing it), so fall back to reading the worktree.
    const oldContent = /^0+$/.test(oldOid) ? '' : getBlobContent(oldOid, repoAbs)
    const newContent = /^0+$/.test(newOid) ? '' : getBlobContent(newOid, repoAbs) ?? getWorktreeFileContent(lookupPath, repoAbs)
    if (oldContent == null || newContent == null) {
      return c.json({ error: 'Content unavailable' }, 404)
    }
    return c.json({ old: oldContent, new: newContent })
  })

  app.get('/api/settings', (c) => {
    return c.json(loadSettings())
  })

  app.put('/api/settings', async (c) => {
    const body = await c.req.json()
    const settings = saveSettings(body)
    return c.json(settings)
  })

  app.get('/api/ai-note', (c) => {
    return c.json({ note: cache.loadAiNote() })
  })

  app.put('/api/ai-note', async (c) => {
    const { note } = await c.req.json()
    cache.saveAiNote(typeof note === 'string' ? note : '')
    return c.json({ ok: true })
  })

  app.get('/api/viewed', (c) => {
    return c.json(Object.fromEntries(viewedFiles))
  })

  app.put('/api/viewed', async (c) => {
    const { filePath, viewed, contentHash } = await c.req.json<{ filePath: string; viewed: boolean; contentHash?: string }>()
    if (viewed) {
      if (typeof contentHash !== 'string' || contentHash.length === 0) {
        return c.json({ error: 'non-empty contentHash required when marking viewed' }, 400)
      }
      viewedFiles.set(filePath, contentHash)
    } else {
      viewedFiles.delete(filePath)
    }
    return c.json({ ok: true })
  })

  app.get('/api/comments', async (c) => {
    const comments = await store.getAll()
    return c.json(comments)
  })

  app.post('/api/comments', async (c) => {
    const body = await c.req.json()
    // First comment on a commit snapshots that commit's per-file blob oids
    // so every later "diff since comment" can be rebuilt by git.
    if (typeof body.commitSha === 'string' && body.commitSha) {
      try {
        const repoRel = typeof body.repo === 'string' ? body.repo : ''
        if (!cache.getPatchset(repoRel, body.commitSha)) {
          const repoAbs = workspace ? join(workspace.root, repoRel) : cacheRoot
          cache.savePatchset(repoRel, body.commitSha, extractPatchsetFiles(await getCommitPatch(body.commitSha, repoAbs)))
        }
      } catch (err) {
        console.warn('diffx: failed to snapshot patchset:', err instanceof Error ? err.message : err)
      }
    }
    const comment = {
      id: crypto.randomUUID(),
      filePath: body.filePath,
      side: body.side,
      lineNumber: body.lineNumber,
      lineContent: body.lineContent,
      body: body.body,
      status: 'open' as const,
      createdAt: Date.now(),
      replies: [],
      ...(typeof body.repo === 'string' && { repo: body.repo }),
      ...(typeof body.commitSha === 'string' && { commitSha: body.commitSha }),
      ...(typeof body.fileOid === 'string' && { fileOid: body.fileOid }),
      ...(typeof body.columnStart === 'number' && typeof body.columnEnd === 'number' && { columnStart: body.columnStart, columnEnd: body.columnEnd }),
    }
    const created = await store.add(comment)
    return c.json(created, 201)
  })

  app.put('/api/comments/:id', async (c) => {
    const id = c.req.param('id')
    const { body, status } = await c.req.json()
    const updated = await store.update(id, { body, status })
    if (!updated) return c.json({ error: 'Comment not found' }, 404)
    return c.json(updated)
  })

  app.post('/api/comments/:id/replies', async (c) => {
    const commentId = c.req.param('id')
    const { body, author } = await c.req.json()
    const reply = {
      id: crypto.randomUUID(),
      body,
      createdAt: Date.now(),
      ...(author === 'user' && { author: 'user' as const }),
    }
    const updated = await store.addReply(commentId, reply)
    if (!updated) return c.json({ error: 'Comment not found' }, 404)
    return c.json(updated)
  })

  app.delete('/api/comments/:id', async (c) => {
    const id = c.req.param('id')
    const removed = await store.remove(id)
    if (!removed) return c.json({ error: 'Comment not found' }, 404)
    return c.json({ ok: true })
  })

  // What changed in a file since a comment was made: diff the blob oid
  // snapshotted at comment time against the file's current blob oid.
  app.get('/api/patchset-diff', (c) => {
    const repoRel = c.req.query('repo') ?? ''
    const commit = c.req.query('commit')
    const path = c.req.query('path')
    if (!commit || !path) {
      return c.json({ error: 'Missing commit or path' }, 400)
    }
    const snapshot = cache.getPatchset(repoRel, commit)?.files[path]
    if (!snapshot) {
      return c.json({ error: 'No patchset snapshot for this commit' }, 404)
    }
    const repoAbs = workspace ? join(workspace.root, repoRel) : cacheRoot
    // "Current" is the file's blob in the repo's HEAD tree — not the commented
    // commit itself (which still exists in the odb even after amend/rebase, so
    // comparing against it would always report "unchanged").
    let currentOid: string
    try {
      currentOid = execFileSync('git', ['rev-parse', '-q', '--verify', `HEAD:${path}`], {
        cwd: repoAbs,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
    } catch {
      return c.json({ error: 'File not in current patchset' }, 404)
    }
    if (!currentOid) {
      return c.json({ error: 'File not in current patchset' }, 404)
    }
    if (currentOid === snapshot.newOid) {
      return c.json({ patch: '' })
    }
    try {
      const patch = execFileSync('git', [...GIT_CONFIG, 'diff', '--no-color', snapshot.newOid, currentOid], {
        encoding: 'utf-8',
        maxBuffer: 50 * 1024 * 1024,
        cwd: repoAbs,
      })
      return c.json({ patch })
    } catch {
      return c.json({ error: 'Patch unavailable' }, 404)
    }
  })

  app.get('/*', async (c) => {
    let filePath = c.req.path
    if (filePath === '/') filePath = '/index.html'

    const relativePath = filePath.slice(1)
    if (!isSafePath(relativePath, clientDir)) {
      return c.text('Forbidden', 403)
    }
    const fullPath = resolve(clientDir, relativePath)
    try {
      const content = await readFile(fullPath)
      const ext = extname(fullPath)
      const contentType = MIME_TYPES[ext] || 'application/octet-stream'
      return new Response(content, {
        headers: { 'Content-Type': contentType },
      })
    } catch {
      const indexContent = await readFile(join(clientDir, 'index.html'))
      return new Response(indexContent, {
        headers: { 'Content-Type': 'text/html' },
      })
    }
  })

  return app
}

export function startServer(options: {
  port: number
  host: string
  clientDir: string
  customDiffArgs?: string[]
  workspace?: WorkspaceContext
}): Promise<{ port: number }> {
  const app = createApp(options.clientDir, options.customDiffArgs, undefined, options.workspace)

  return new Promise((resolve) => {
    const server = serve({
      fetch: app.fetch,
      port: options.port,
      hostname: options.host,
    }, (info) => {
      resolve({ port: info.port })
    })
  })
}
