import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { GIT_CONFIG, execFileP, getBranchName, getCommitPatch, getCustomGitDiff, getGitDiff, getRepoRoot, resolveDiffBase } from './git.js'

// Directory names we never descend into during repo discovery. .repo alone is
// tens of GB on repo-tool workspaces and holds git dirs that are not worktrees.
const PRUNE_DIRS = new Set(['.repo', 'node_modules', 'out', '.git'])

function toplevelInside(rootAbs: string, dir: string): string | null {
  try {
    const toplevel = resolve(getRepoRoot(dir))
    const rel = relative(rootAbs, toplevel)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null
    return rel
  } catch {
    return null
  }
}

// Authoritative repo list for repo-tool workspaces: parse .repo/manifest.xml
// (following <include>) plus .repo/local_manifests/*.xml. Only path/name and
// remove-project are consumed — manifest dialects beyond that are ignored.
// Returns null when there is no .repo dir (caller falls back to fs scan).
export function parseManifestRepos(root: string): string[] | null {
  const repoDir = join(root, '.repo')
  if (!existsSync(repoDir)) return null

  const projects: { name?: string; path?: string }[] = []
  const removed = new Set<string>()

  const attrs = (tag: string): Record<string, string> => {
    const out: Record<string, string> = {}
    for (const m of tag.matchAll(/(\w+)\s*=\s*"([^"]*)"|(\w+)\s*=\s*'([^']*)'/g)) {
      out[m[1] ?? m[3]] = m[2] ?? m[4]
    }
    return out
  }

  const parseFile = (file: string): void => {
    let text: string
    try {
      text = readFileSync(file, 'utf-8')
    } catch {
      return
    }
    for (const m of text.matchAll(/<(project|remove-project|include)\b([^>]*)>/g)) {
      const a = attrs(m[2])
      if (m[1] === 'project') {
        projects.push({ name: a.name, path: a.path })
      } else if (m[1] === 'remove-project') {
        if (a.name) removed.add(a.name)
        if (a.path) removed.add(a.path)
      } else if (m[1] === 'include' && a.name) {
        parseFile(join(repoDir, 'manifests', a.name))
      }
    }
  }

  parseFile(join(repoDir, 'manifest.xml'))
  try {
    for (const entry of readdirSync(join(repoDir, 'local_manifests'))) {
      if (entry.endsWith('.xml')) parseFile(join(repoDir, 'local_manifests', entry))
    }
  } catch {
    // no local_manifests dir
  }

  const candidates = new Set<string>()
  for (const p of projects) {
    const rel = p.path ?? p.name
    if (!rel) continue
    if (removed.has(rel) || (p.name && removed.has(p.name))) continue
    candidates.add(rel)
  }

  const rootAbs = resolve(root)
  const result = new Set<string>()
  for (const rel of candidates) {
    // ponytail: tag-regex manifest parser; switch to an XML lib if exotic
    // manifests ever need groups/remote handling.
    const relTop = toplevelInside(rootAbs, resolve(rootAbs, rel))
    if (relTop === null) {
      console.warn(`diffx: skipping manifest project ${rel}: not a git repository`)
      continue
    }
    result.add(relTop)
  }
  return [...result].sort()
}

// Fallback discovery for non-manifest multi-repo dirs: unlimited-depth walk
// matching `.git` by name (file, dir, or symlink — symlinks are never
// followed), normalizing every hit through rev-parse and rejecting toplevels
// outside the workspace. Nested repos are kept; stripPrefix's longest-match
// disambiguates them.
export function discoverRepos(root: string): string[] {
  const rootAbs = resolve(root)
  const result = new Set<string>()

  const addRepo = (dir: string): void => {
    const rel = toplevelInside(rootAbs, dir)
    if (rel !== null) result.add(rel)
  }

  const isRepo = (dir: string): boolean => {
    try {
      lstatSync(join(dir, '.git'))
      return true
    } catch {
      return false
    }
  }

  const visit = (dir: string): void => {
    if (isRepo(dir)) addRepo(dir)
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue // files and symlinked dirs are never followed
      const child = join(dir, entry.name)
      if (PRUNE_DIRS.has(entry.name)) {
        // still test the pruned dir itself for .git (e.g. node_modules can be
        // a repo), just never descend into it
        if (isRepo(child)) addRepo(child)
        continue
      }
      visit(child)
    }
  }

  visit(rootAbs)
  return [...result].sort()
}

// Repo list for a workspace root: repo manifest when present (authoritative),
// fs scan otherwise. An empty manifest parse also falls back to the scan.
export function discoverWorkspace(root: string): { repos: string[]; source: 'manifest' | 'scan' } {
  const fromManifest = parseManifestRepos(root)
  if (fromManifest && fromManifest.length > 0) return { repos: fromManifest, source: 'manifest' }
  return { repos: discoverRepos(root), source: 'scan' }
}

export function stripPrefix(path: string, repos: string[]): { repo: string; filePath: string } | null {
  let best: string | null = null
  for (const repo of repos) {
    if (!path.startsWith(repo + '/')) continue
    if (best === null || repo.length > best.length) best = repo
  }
  return best === null ? null : { repo: best, filePath: path.slice(best.length + 1) }
}

// Rewrite a unified-diff patch so every file path carries the `<relPath>/`
// prefix. Only column-0 header lines carry paths (hunk body lines start with
// space/+/-), so anchoring at column 0 already excludes content lines.
// Quoted-path forms are passed through untouched (degraded: that file shows
// unprefixed and content lookups 404 — no crash).
export function prefixPatch(patch: string, relPath: string): string {
  if (!relPath) return patch
  const p = (path: string) => `${relPath}/${path}`
  const side = (s: string): string => {
    if (s === '/dev/null') return s
    const m = s.match(/^([ab])\/(.*)$/)
    return m ? `${m[1]}/${p(m[2])}` : s
  }
  return patch
    .split('\n')
    .map((line) => {
      let m: RegExpMatchArray | null
      if ((m = line.match(/^diff --git a\/(.*) b\/(.*)$/))) {
        return `diff --git a/${p(m[1])} b/${p(m[2])}`
      }
      if ((m = line.match(/^--- a\/(.*)$/))) return `--- a/${p(m[1])}`
      if ((m = line.match(/^\+\+\+ b\/(.*)$/))) return `+++ b/${p(m[1])}`
      if ((m = line.match(/^rename from (.*)$/)) && !m[1].startsWith('"')) return `rename from ${p(m[1])}`
      if ((m = line.match(/^rename to (.*)$/)) && !m[1].startsWith('"')) return `rename to ${p(m[1])}`
      if ((m = line.match(/^copy from (.*)$/)) && !m[1].startsWith('"')) return `copy from ${p(m[1])}`
      if ((m = line.match(/^copy to (.*)$/)) && !m[1].startsWith('"')) return `copy to ${p(m[1])}`
      if ((m = line.match(/^Binary files (.*) and (.*) differ$/))) {
        return `Binary files ${side(m[1])} and ${side(m[2])} differ`
      }
      return line
    })
    .join('\n')
}

export interface RepoDiffOptions {
  customDiffArgs?: string[]
  untracked?: boolean
  commit?: string
  untrackedList?: string[]
}

// Per-repo patch generation shared by /api/diff and /api/file-versions so
// both endpoints regenerate byte-identical diffs (file-versions validates the
// requested oids against it). Diff base is `git diff <base>` with base =
// upstream or the repo-tool manifest ref — one diff covering local commits
// plus uncommitted changes; no base at all falls back to the working-tree
// diff (staged always included — there is no staged toggle in workspace mode
// to hide it behind).
//
// Regenerating a large repo's patch takes hundreds of ms of git, and the
// client fires one file-versions request per changed file right after loading
// — each previously re-ran the owning repo's full diff. Memoize briefly;
// concurrent callers share the in-flight computation. untrackedList is derived
// from the same repo state, so it stays out of the cache key.
// ponytail: 5s TTL — worktree edits within the window serve the older patch.
const PATCH_TTL_MS = 5_000
const patchMemo = new Map<string, { at: number; p: Promise<string> }>()

export function getRepoPatch(opts: RepoDiffOptions, repoAbs: string): Promise<string> {
  const key = `${repoAbs}\0${opts.commit ?? ''}\0${opts.customDiffArgs?.join(' ') ?? ''}\0${opts.untracked ? 1 : 0}`
  // Cap memory: patches are MBs and commit views mint a key each. Prune
  // expired entries once the map grows past the cap.
  if (patchMemo.size > 512) {
    const cutoff = Date.now() - PATCH_TTL_MS
    for (const [k, v] of patchMemo) if (v.at < cutoff) patchMemo.delete(k)
  }
  const hit = patchMemo.get(key)
  if (hit && Date.now() - hit.at < PATCH_TTL_MS) return hit.p
  const p = (async () => {
    if (opts.commit) return getCommitPatch(opts.commit, repoAbs)
    if (opts.customDiffArgs && opts.customDiffArgs.length > 0) return getCustomGitDiff(opts.customDiffArgs, repoAbs)
    const base = await resolveDiffBase(repoAbs)
    return getGitDiff(
      base ? { base, untracked: opts.untracked, untrackedList: opts.untrackedList } : { staged: true, untracked: opts.untracked, untrackedList: opts.untrackedList },
      repoAbs,
    )
  })().catch((err) => {
    patchMemo.delete(key)
    throw err
  })
  patchMemo.set(key, { at: Date.now(), p })
  return p
}

export interface CommitInfo {
  sha: string
  subject: string
  date: string
}

export interface RepoCommits {
  repo: string
  branch: string
  commits: CommitInfo[]
}

// Unpushed commits for one repo (`<base>..HEAD`, base = upstream or manifest
// ref). Returns null when no base exists (repo omitted from the commit list).
export async function getRepoCommits(repoAbs: string, repo: string): Promise<RepoCommits | null> {
  const [base, branchName] = await Promise.all([resolveDiffBase(repoAbs), getBranchName(repoAbs)])
  if (!base) return null
  let out: string
  try {
    const { stdout } = await execFileP('git', [...GIT_CONFIG, 'log', '--no-merges', '--format=%H%x1f%s%x1f%cI', `${base}..HEAD`], {
      encoding: 'utf-8',
      maxBuffer: 50 * 1024 * 1024,
      cwd: repoAbs,
    })
    out = stdout
  } catch {
    return null
  }
  const commits = out
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      const [sha, subject, date] = l.split('\x1f')
      return { sha, subject, date }
    })
  // detached HEAD reports the literal branch "HEAD" — show the manifest
  // branch name instead (m/dev → dev)
  const branch =
    branchName === 'HEAD' && base.startsWith('refs/remotes/m/') ? base.slice('refs/remotes/m/'.length) : branchName
  return { repo, branch, commits }
}
