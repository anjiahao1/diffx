import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { TestContext } from 'node:test'

/** Create a unique temp dir, removed automatically when the test finishes. */
export function makeTempDir(t: TestContext, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix + '-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

export function gitInit(dir: string): void {
  execFileSync('git', ['init', '-q', dir])
}

/** mkdir -p + git init at <root>/<relPath>. */
export function makeGitRepo(root: string, relPath: string): void {
  const dir = join(root, relPath)
  mkdirSync(dir, { recursive: true })
  gitInit(dir)
}

/** mkdir -p only (no .git) at <root>/<relPath>. */
export function makePlainDir(root: string, relPath: string): void {
  mkdirSync(join(root, relPath), { recursive: true })
}

function writeFile(root: string, relPath: string, content: string): void {
  const file = join(root, relPath)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
}

function manifestXml(body: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<manifest>',
    '  <remote name="origin" fetch="."/>',
    '  <default revision="refs/heads/main" remote="origin"/>',
    body,
    '</manifest>',
    '',
  ].join('\n')
}

function localManifestXml(body: string): string {
  return ['<?xml version="1.0" encoding="UTF-8"?>', '<manifest>', body, '</manifest>', ''].join('\n')
}

export interface WorkspaceOptions {
  /** Content of .repo/manifests/manifest.xml (also symlinked from .repo/manifest.xml). */
  manifest?: string
  /** Extra files under .repo/manifests/, e.g. targets of <include name="..."/>. */
  includedFiles?: Record<string, string>
  /** Files under .repo/local_manifests/, e.g. { 'extra.xml': '<project .../>' }. */
  localManifests?: Record<string, string>
  /** Rel paths under root to git init. */
  repos?: string[]
  /** Rel paths under root to create as plain dirs (no .git). */
  plainDirs?: string[]
}

/**
 * Build a repo-tool style workspace at root: .repo/manifests/manifest.xml plus
 * optional includes/local_manifests, and real git repos on disk.
 */
export function buildWorkspace(root: string, opts: WorkspaceOptions): void {
  if (opts.manifest !== undefined) {
    writeFile(root, '.repo/manifests/manifest.xml', opts.manifest)
    symlinkSync('manifests/manifest.xml', join(root, '.repo', 'manifest.xml'))
  }
  for (const [name, content] of Object.entries(opts.includedFiles ?? {})) {
    writeFile(root, join('.repo', 'manifests', name), content)
  }
  for (const [name, content] of Object.entries(opts.localManifests ?? {})) {
    writeFile(root, join('.repo', 'local_manifests', name), localManifestXml(content))
  }
  for (const relPath of opts.repos ?? []) {
    makeGitRepo(root, relPath)
  }
  for (const relPath of opts.plainDirs ?? []) {
    makePlainDir(root, relPath)
  }
}

export { manifestXml, localManifestXml }
