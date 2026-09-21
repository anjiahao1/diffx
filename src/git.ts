import { execFile as execFileCb, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { basename, join, resolve } from 'node:path'
import { readFileSync, lstatSync, readlinkSync } from 'node:fs'
import { open, readFile } from 'node:fs/promises'
import { isSafePath } from './path.js'
import { parseSync as parseEditorConfig, type ProcessedFileConfig } from 'editorconfig'

// Async git spawn for the per-request paths: /api/diff and /api/commits fan
// out over every workspace repo, so the calls must run concurrently instead
// of blocking the event loop one spawn at a time.
export const execFileP = promisify(execFileCb)

const DIFF_MAXBUFFER = 50 * 1024 * 1024

const IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico', '.avif',
])

export function isImageFile(filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase()
  return IMAGE_EXTENSIONS.has(ext)
}

async function isBinaryFile(absolutePath: string): Promise<boolean> {
  let fh
  try {
    fh = await open(absolutePath, 'r')
  } catch {
    return true
  }
  try {
    const buffer = Buffer.alloc(8192)
    const { bytesRead } = await fh.read(buffer, 0, 8192, 0)
    for (let i = 0; i < bytesRead; i++) {
      if (buffer[i] === 0) return true
    }
    return false
  } catch {
    return true
  } finally {
    await fh.close()
  }
}

export function getFileContent(filePath: string, version: 'old' | 'new', root: string = getRepoRoot()): Buffer | null {
  if (!isSafePath(filePath, root)) {
    return null
  }
  const resolved = resolve(root, filePath)
  if (version === 'new') {
    try {
      return readFileSync(resolved)
    } catch {
      return null
    }
  }
  // old version: try staged first, then HEAD
  try {
    return execFileSync('git', ['show', `HEAD:${filePath}`], { stdio: 'pipe', maxBuffer: 50 * 1024 * 1024, cwd: root })
  } catch {
    return null
  }
}

const BLOB_OID_REGEX = /^[0-9a-f]{4,64}$/

export function getBlobContent(oid: string, cwd?: string): string | null {
  if (!BLOB_OID_REGEX.test(oid) || /^0+$/.test(oid)) {
    return null
  }
  try {
    return execFileSync('git', ['cat-file', 'blob', oid], { encoding: 'utf-8', stdio: 'pipe', maxBuffer: 50 * 1024 * 1024, cwd })
  } catch {
    return null
  }
}

export function getWorktreeFileContent(filePath: string, root: string = getRepoRoot()): string | null {
  if (!isSafePath(filePath, root)) {
    return null
  }
  const resolved = resolve(root, filePath)
  try {
    // Match git's notion of the worktree blob: for a symlink that is the
    // target string, never the contents of the file it points at (which
    // could be outside the repository).
    const stats = lstatSync(resolved)
    if (stats.isSymbolicLink()) {
      return readlinkSync(resolved, 'utf-8')
    }
    if (!stats.isFile()) {
      return null
    }
    return readFileSync(resolved, 'utf-8')
  } catch {
    return null
  }
}

export function isGitRepo(): boolean {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

export function getRepoRoot(cwd?: string): string {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf-8',
    // callers probe repos that may be invalid (manifest validation) — the
    // expected "not a git repository" fatal must not leak to the console
    stdio: 'pipe',
    cwd,
  }).trim()
}

export function getRepoName(): string {
  return basename(getRepoRoot())
}

export function getBranchName(cwd?: string): Promise<string> {
  return branchMemo.get(cwd ?? process.cwd(), async () => {
    try {
      const { stdout } = await execFileP('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf-8', cwd })
      return stdout.trim()
    } catch {
      return ''
    }
  })
}

// Base-ref and branch lookups spawn one git process per repo per request;
// across a 400+-repo workspace those auxiliary spawns dominate request cost.
// Both change rarely mid-session (checkout, upstream edit), so memoize
// briefly. Concurrent callers share one in-flight computation.
// ponytail: fixed TTL — a checkout within TTL shows a stale branch label;
// drop these caches if that ever matters.
const AUX_TTL_MS = 60_000

function memoAsync<T>(ttlMs: number): {
  get: (key: string, compute: () => Promise<T>) => Promise<T>
} {
  const entries = new Map<string, { at: number; v: Promise<T> }>()
  return {
    get(key, compute) {
      const hit = entries.get(key)
      if (hit && Date.now() - hit.at < ttlMs) return hit.v
      const v = compute().catch((err) => {
        entries.delete(key)
        throw err
      })
      entries.set(key, { at: Date.now(), v })
      return v
    },
  }
}

const baseMemo = memoAsync<string | null>(AUX_TTL_MS)
const branchMemo = memoAsync<string>(AUX_TTL_MS)
const untrackedMemo = memoAsync<string[]>(5_000)

// Force standard unified diff regardless of user's git config
// (e.g. diff.external = difftastic, color.ui = always). The -c flags must
// precede the subcommand: quotePath off keeps non-ASCII (CJK) filenames raw —
// octal-quoted paths are unparseable downstream. Explicit a/ b/ prefixes guard
// against diff.noprefix / custom prefix config breaking parser invariants.
export const GIT_CONFIG = ['-c', 'core.quotePath=false'] as const
const DIFF_FLAGS = ['--no-ext-diff', '--no-color', '--src-prefix=a/', '--dst-prefix=b/'] as const

export async function getCustomGitDiff(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await execFileP('git', [...GIT_CONFIG, 'diff', ...DIFF_FLAGS, ...args], { encoding: 'utf-8', maxBuffer: DIFF_MAXBUFFER, cwd })
  return stdout
}

// Diff base resolution for "local delta" diffs: the branch upstream when one
// exists, else the repo-tool manifest ref `refs/remotes/m/*` — repo sync
// checks out a detached HEAD, and m/<branch> is the manifest base the user
// means by "base". Null = no sensible base (fall back to working diff).
export async function resolveDiffBase(cwd?: string): Promise<string | null> {
  return baseMemo.get(cwd ?? process.cwd(), async () => {
    try {
      await execFileP('git', ['rev-parse', '-q', '--verify', '@{u}'], { cwd })
      return '@{u}'
    } catch {
      // no upstream: detached HEAD or tracking-less branch
    }
    try {
      const { stdout } = await execFileP('git', ['for-each-ref', 'refs/remotes/m', '--format=%(refname)'], {
        encoding: 'utf-8',
        cwd,
      })
      const refs = stdout.trim()
      const lines = refs ? refs.split('\n').filter(Boolean) : []
      if (lines.length === 1) return lines[0]
      // multiple manifest refs: the base is the one HEAD is ahead of
      for (const ref of lines) {
        try {
          await execFileP('git', ['merge-base', '--is-ancestor', ref, 'HEAD'], { cwd })
          return ref
        } catch {
          // not an ancestor of HEAD
        }
      }
    } catch {
      // no m/ refs (not a repo-tool workspace)
    }
    return null
  })
}

// Single-commit patch (`git show` handles the root commit by diffing against
// the empty tree; merge commits in the list are excluded at query time).
export async function getCommitPatch(sha: string, cwd?: string): Promise<string> {
  const { stdout } = await execFileP('git', [...GIT_CONFIG, 'show', '--format=', ...DIFF_FLAGS, sha], { encoding: 'utf-8', maxBuffer: DIFF_MAXBUFFER, cwd })
  return stdout
}

// Full commit message (subject + body) for reviewable commits; null when the
// sha doesn't resolve to a commit.
export async function getCommitMessage(sha: string, cwd?: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP('git', [...GIT_CONFIG, 'log', '-1', '--format=%B', sha], { encoding: 'utf-8', cwd })
    const msg = stdout.trim()
    return msg || null
  } catch {
    return null
  }
}

export async function getGitDiff(
  options: { staged?: boolean; untracked?: boolean; base?: string; untrackedList?: string[] } = {},
  cwd?: string,
): Promise<string> {
  const parts: string[] = []

  if (options.base) {
    // Local-vs-base diff for workspace mode: one diff covering local commits
    // plus uncommitted changes since the resolved base (upstream or manifest
    // ref). staged toggle is meaningless here — its content is included.
    const vs = await execFileP('git', [...GIT_CONFIG, 'diff', ...DIFF_FLAGS, options.base], { encoding: 'utf-8', maxBuffer: DIFF_MAXBUFFER, cwd })
    if (vs.stdout) parts.push(vs.stdout)
  } else {
    // unstaged changes (always included as the base)
    const unstaged = await execFileP('git', [...GIT_CONFIG, 'diff', ...DIFF_FLAGS], { encoding: 'utf-8', maxBuffer: DIFF_MAXBUFFER, cwd })
    if (unstaged.stdout) parts.push(unstaged.stdout)

    // staged changes
    if (options.staged) {
      const staged = await execFileP('git', [...GIT_CONFIG, 'diff', ...DIFF_FLAGS, '--staged'], { encoding: 'utf-8', maxBuffer: DIFF_MAXBUFFER, cwd })
      if (staged.stdout) parts.push(staged.stdout)
    }
  }

  // untracked files
  if (options.untracked) {
    const root = cwd ?? getRepoRoot()
    const untrackedPatch = await getUntrackedFilesDiff(root, options.untrackedList ?? (await getUntrackedFilePaths(root)))
    if (untrackedPatch) parts.push(untrackedPatch)
  }

  return parts.join('\n')
}

export function getTabSizeForFiles(filePaths: string[], root: string = getRepoRoot()): Record<string, number> {
  const cache = new Map<string, ProcessedFileConfig>()
  const result: Record<string, number> = {}
  for (const filePath of filePaths) {
    try {
      const absPath = join(root, filePath)
      const config = parseEditorConfig(absPath, { cache })
      const size = config.tab_width ?? (config.indent_size === 'tab' ? undefined : config.indent_size)
      if (typeof size === 'number') {
        result[filePath] = size
      }
    } catch {
      // skip files that fail to resolve
    }
  }
  return result
}

// Embedded git repositories show up in ls-files --others as "dir/" entries —
// they have no diffable file content in this repo, so drop them.
function parseUntrackedList(output: string): string[] {
  return output ? output.split('\n').filter((f) => f && !f.endsWith('/')) : []
}

export function getUntrackedFilePaths(cwd?: string): Promise<string[]> {
  // Same staleness class as the patch cache: untracked file listing is part
  // of the patch this server just served.
  return untrackedMemo.get(cwd ?? process.cwd(), async () => {
    const { stdout } = await execFileP('git', ['ls-files', '--others', '--exclude-standard'], {
      encoding: 'utf-8',
      maxBuffer: DIFF_MAXBUFFER,
      cwd,
    })
    return parseUntrackedList(stdout.trim())
  })
}

async function getUntrackedFilesDiff(root: string, files: string[]): Promise<string> {
  if (files.length === 0) return ''

  const patches = await Promise.all(
    files.map(async (file): Promise<string | null> => {
      const absolutePath = join(root, file)
      if (await isBinaryFile(absolutePath)) {
        return [
          `diff --git a/${file} b/${file}`,
          'new file mode 100644',
          'index 0000000..0000001',
          `Binary files /dev/null and b/${file} differ`,
        ].join('\n')
      }
      try {
        const content = await readFile(absolutePath, 'utf-8')
        const lines = content.split('\n')
        const diffLines = lines.map((l: string) => `+${l}`)
        return [
          `diff --git a/${file} b/${file}`,
          'new file mode 100644',
          'index 0000000..0000001',
          '--- /dev/null',
          `+++ b/${file}`,
          `@@ -0,0 +1,${lines.length} @@`,
          ...diffLines,
        ].join('\n')
      } catch {
        return null // skip unreadable files
      }
    }),
  )

  const kept = patches.filter((p): p is string => p !== null)
  return kept.length > 0 ? '\n' + kept.join('\n') : ''
}
