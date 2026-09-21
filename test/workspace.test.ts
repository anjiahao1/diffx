import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { parseManifestRepos, discoverRepos, prefixPatch, stripPrefix } from '../src/workspace.js'
import { buildWorkspace, gitInit, makeTempDir, manifestXml } from './fixtures.js'

// ---------------------------------------------------------------------------
// prefixPatch
// ---------------------------------------------------------------------------

function assertPatchEqual(actual: string, expected: string): void {
  // tolerate a trailing-newline difference at the end of the whole patch
  assert.equal(actual.replace(/\n$/, ''), expected.replace(/\n$/, ''))
}

const prefixPatchCases: Array<{ name: string; patch: string; expected: string }> = [
  {
    name: 'simple modification prefixes the three path lines and leaves the hunk byte-identical',
    patch: [
      'diff --git a/x.c b/x.c',
      'index 1234abc..5678def 100644',
      '--- a/x.c',
      '+++ b/x.c',
      '@@ -1,3 +1,3 @@',
      ' int main() {',
      '-  return 0;',
      '+  return 1;',
      '}',
    ].join('\n'),
    expected: [
      'diff --git a/repoA/x.c b/repoA/x.c',
      'index 1234abc..5678def 100644',
      '--- a/repoA/x.c',
      '+++ b/repoA/x.c',
      '@@ -1,3 +1,3 @@',
      ' int main() {',
      '-  return 0;',
      '+  return 1;',
      '}',
    ].join('\n'),
  },
  {
    name: 'file addition keeps --- /dev/null and new file mode untouched',
    patch: [
      'diff --git a/new.txt b/new.txt',
      'new file mode 100644',
      'index 0000000..e69de29',
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1 @@',
      '+hello',
    ].join('\n'),
    expected: [
      'diff --git a/repoA/new.txt b/repoA/new.txt',
      'new file mode 100644',
      'index 0000000..e69de29',
      '--- /dev/null',
      '+++ b/repoA/new.txt',
      '@@ -0,0 +1 @@',
      '+hello',
    ].join('\n'),
  },
  {
    name: 'file deletion keeps +++ /dev/null and deleted file mode untouched',
    patch: [
      'diff --git a/old.txt b/old.txt',
      'deleted file mode 100644',
      'index e69de29..0000000',
      '--- a/old.txt',
      '+++ /dev/null',
    ].join('\n'),
    expected: [
      'diff --git a/repoA/old.txt b/repoA/old.txt',
      'deleted file mode 100644',
      'index e69de29..0000000',
      '--- a/repoA/old.txt',
      '+++ /dev/null',
    ].join('\n'),
  },
  {
    name: 'pure rename prefixes rename from/to, leaves similarity index untouched',
    patch: [
      'diff --git a/old.c b/new.c',
      'similarity index 100%',
      'rename from old.c',
      'rename to new.c',
    ].join('\n'),
    expected: [
      'diff --git a/repoA/old.c b/repoA/new.c',
      'similarity index 100%',
      'rename from repoA/old.c',
      'rename to repoA/new.c',
    ].join('\n'),
  },
  {
    name: 'rename + edit prefixes the differing diff --git sides plus rename from/to',
    patch: [
      'diff --git a/old.c b/new.c',
      'similarity index 85%',
      'rename from old.c',
      'rename to new.c',
      'index abc1234..def5678 100644',
      '--- a/old.c',
      '+++ b/new.c',
      '@@ -1 +1 @@',
      '-old content',
      '+new content',
    ].join('\n'),
    expected: [
      'diff --git a/repoA/old.c b/repoA/new.c',
      'similarity index 85%',
      'rename from repoA/old.c',
      'rename to repoA/new.c',
      'index abc1234..def5678 100644',
      '--- a/repoA/old.c',
      '+++ b/repoA/new.c',
      '@@ -1 +1 @@',
      '-old content',
      '+new content',
    ].join('\n'),
  },
  {
    name: 'copy from/to lines are prefixed',
    patch: [
      'diff --git a/src.c b/dst.c',
      'similarity index 90%',
      'copy from src.c',
      'copy to dst.c',
      'index 1111111..2222222 100644',
      '--- a/src.c',
      '+++ b/dst.c',
      '@@ -1 +1 @@',
      '-body',
      '+body',
    ].join('\n'),
    expected: [
      'diff --git a/repoA/src.c b/repoA/dst.c',
      'similarity index 90%',
      'copy from repoA/src.c',
      'copy to repoA/dst.c',
      'index 1111111..2222222 100644',
      '--- a/repoA/src.c',
      '+++ b/repoA/dst.c',
      '@@ -1 +1 @@',
      '-body',
      '+body',
    ].join('\n'),
  },
  {
    name: 'binary files both sides prefixed',
    patch: [
      'diff --git a/x.bin b/y.bin',
      'index 1234567..89abcd0 100644',
      'Binary files a/x.bin and b/y.bin differ',
    ].join('\n'),
    expected: [
      'diff --git a/repoA/x.bin b/repoA/y.bin',
      'index 1234567..89abcd0 100644',
      'Binary files a/repoA/x.bin and b/repoA/y.bin differ',
    ].join('\n'),
  },
  {
    name: 'binary addition keeps /dev/null side untouched',
    patch: [
      'diff --git a/new.bin b/new.bin',
      'new file mode 100644',
      'index 0000000..1234567',
      'Binary files /dev/null and b/new.bin differ',
    ].join('\n'),
    expected: [
      'diff --git a/repoA/new.bin b/repoA/new.bin',
      'new file mode 100644',
      'index 0000000..1234567',
      'Binary files /dev/null and b/repoA/new.bin differ',
    ].join('\n'),
  },
  {
    name: 'binary deletion keeps /dev/null side untouched',
    patch: [
      'diff --git a/old.bin b/old.bin',
      'deleted file mode 100644',
      'index 1234567..0000000',
      'Binary files a/old.bin and /dev/null differ',
    ].join('\n'),
    expected: [
      'diff --git a/repoA/old.bin b/repoA/old.bin',
      'deleted file mode 100644',
      'index 1234567..0000000',
      'Binary files a/repoA/old.bin and /dev/null differ',
    ].join('\n'),
  },
  {
    name: 'mode-only change prefixes diff --git, leaves old/new mode lines untouched',
    patch: [
      'diff --git a/s.sh b/s.sh',
      'old mode 100644',
      'new mode 100755',
    ].join('\n'),
    expected: [
      'diff --git a/repoA/s.sh b/repoA/s.sh',
      'old mode 100644',
      'new mode 100755',
    ].join('\n'),
  },
  {
    name: 'quoted paths pass through unchanged (documented degradation, no crash)',
    patch: 'diff --git "a/we ird" "b/we ird"',
    expected: 'diff --git "a/we ird" "b/we ird"',
  },
  {
    name: 'hunk content starting with "diff --git " is not rewritten (column-0 anchoring)',
    patch: [
      'diff --git a/x.c b/x.c',
      'index 1234abc..5678def 100644',
      '--- a/x.c',
      '+++ b/x.c',
      '@@ -1,2 +1,3 @@',
      '+diff --git a/fake b/fake',
      ' unchanged context',
    ].join('\n'),
    expected: [
      'diff --git a/repoA/x.c b/repoA/x.c',
      'index 1234abc..5678def 100644',
      '--- a/repoA/x.c',
      '+++ b/repoA/x.c',
      '@@ -1,2 +1,3 @@',
      '+diff --git a/fake b/fake',
      ' unchanged context',
    ].join('\n'),
  },
  {
    name: 'CJK filenames are prefixed like ASCII',
    patch: [
      'diff --git a/中文.txt b/中文.txt',
      'index 1234abc..5678def 100644',
      '--- a/中文.txt',
      '+++ b/中文.txt',
      '@@ -1 +1 @@',
      '-旧',
      '+新',
    ].join('\n'),
    expected: [
      'diff --git a/repoA/中文.txt b/repoA/中文.txt',
      'index 1234abc..5678def 100644',
      '--- a/repoA/中文.txt',
      '+++ b/repoA/中文.txt',
      '@@ -1 +1 @@',
      '-旧',
      '+新',
    ].join('\n'),
  },
  {
    name: 'multi-file patch prefixes every section and leaves every index line untouched',
    patch: [
      'diff --git a/one.c b/one.c',
      'index 1234abc..5678def 100644',
      '--- a/one.c',
      '+++ b/one.c',
      '@@ -1 +1 @@',
      '-x',
      '+y',
      'diff --git a/two.c b/two.c',
      'index aaaabbb..cccdddd 100644',
      '--- a/two.c',
      '+++ b/two.c',
      '@@ -1 +1 @@',
      '-p',
      '+q',
    ].join('\n'),
    expected: [
      'diff --git a/repoA/one.c b/repoA/one.c',
      'index 1234abc..5678def 100644',
      '--- a/repoA/one.c',
      '+++ b/repoA/one.c',
      '@@ -1 +1 @@',
      '-x',
      '+y',
      'diff --git a/repoA/two.c b/repoA/two.c',
      'index aaaabbb..cccdddd 100644',
      '--- a/repoA/two.c',
      '+++ b/repoA/two.c',
      '@@ -1 +1 @@',
      '-p',
      '+q',
    ].join('\n'),
  },
]

for (const { name, patch, expected } of prefixPatchCases) {
  test(`prefixPatch: ${name}`, () => {
    assertPatchEqual(prefixPatch(patch, 'repoA'), expected)
  })
}

// ---------------------------------------------------------------------------
// stripPrefix
// ---------------------------------------------------------------------------

test('stripPrefix: exact repo segment match', () => {
  assert.deepEqual(stripPrefix('repoA/file.c', ['repoA', 'repoB']), { repo: 'repoA', filePath: 'file.c' })
})

test('stripPrefix: longest match wins', () => {
  assert.deepEqual(stripPrefix('vendor/build/x.c', ['vendor', 'vendor/build']), {
    repo: 'vendor/build',
    filePath: 'x.c',
  })
})

test('stripPrefix: longest match wins regardless of repo order', () => {
  assert.deepEqual(stripPrefix('vendor/build/x.c', ['vendor/build', 'vendor']), {
    repo: 'vendor/build',
    filePath: 'x.c',
  })
})

test('stripPrefix: nested file path is preserved in filePath', () => {
  assert.deepEqual(stripPrefix('repoA/sub/dir/f.c', ['repoA']), { repo: 'repoA', filePath: 'sub/dir/f.c' })
})

test('stripPrefix: partial segment prefix does not match', () => {
  assert.equal(stripPrefix('repoAX/file.c', ['repoA']), null)
})

test('stripPrefix: unknown path returns null', () => {
  assert.equal(stripPrefix('unknown/x', ['repoA', 'repoB']), null)
})

test('stripPrefix: bare repo root without a slash returns null', () => {
  assert.equal(stripPrefix('repoA', ['repoA']), null)
})

// ---------------------------------------------------------------------------
// parseManifestRepos
// ---------------------------------------------------------------------------

test('parseManifestRepos: returns null when .repo does not exist', (t) => {
  const root = makeTempDir(t, 'diffx-manifest-')
  assert.equal(parseManifestRepos(root), null)
})

test('parseManifestRepos: resolves <include> and uses path attr, falling back to name attr', (t) => {
  const root = makeTempDir(t, 'diffx-manifest-')
  buildWorkspace(root, {
    manifest: manifestXml('  <project name="alpha" path="libs/alpha"/>\n  <include name="default.xml"/>\n'),
    includedFiles: { 'default.xml': manifestXml('  <project name="beta"/>\n') },
    repos: ['libs/alpha', 'beta'],
  })
  assert.deepEqual(parseManifestRepos(root), ['beta', 'libs/alpha'])
})

test('parseManifestRepos: <remove-project> removes the named project', (t) => {
  const root = makeTempDir(t, 'diffx-manifest-')
  buildWorkspace(root, {
    manifest: manifestXml('  <include name="default.xml"/>\n  <remove-project name="gamma"/>\n'),
    includedFiles: {
      'default.xml': manifestXml('  <project name="gamma" path="gamma"/>\n  <project name="alpha" path="libs/alpha"/>\n'),
    },
    repos: ['gamma', 'libs/alpha'],
  })
  assert.deepEqual(parseManifestRepos(root), ['libs/alpha'])
})

test('parseManifestRepos: merges local_manifests projects', (t) => {
  const root = makeTempDir(t, 'diffx-manifest-')
  buildWorkspace(root, {
    manifest: manifestXml('  <project name="alpha" path="libs/alpha"/>\n'),
    localManifests: { 'extra.xml': '  <project name="delta" path="delta"/>\n' },
    repos: ['libs/alpha', 'delta'],
  })
  assert.deepEqual(parseManifestRepos(root), ['delta', 'libs/alpha'])
})

test('parseManifestRepos: skips projects whose path does not exist on disk and warns', (t) => {
  const root = makeTempDir(t, 'diffx-manifest-')
  const warn = t.mock.method(console, 'warn', () => {})
  buildWorkspace(root, {
    manifest: manifestXml('  <project name="ghost" path="missing/ghost"/>\n  <project name="alpha" path="libs/alpha"/>\n'),
    repos: ['libs/alpha'],
  })
  assert.deepEqual(parseManifestRepos(root), ['libs/alpha'])
  assert.ok(warn.mock.callCount() >= 1)
})

test('parseManifestRepos: skips projects that are plain dirs (not git repos) and warns', (t) => {
  const root = makeTempDir(t, 'diffx-manifest-')
  const warn = t.mock.method(console, 'warn', () => {})
  buildWorkspace(root, {
    manifest: manifestXml('  <project name="plain" path="plain"/>\n  <project name="alpha" path="libs/alpha"/>\n'),
    repos: ['libs/alpha'],
    plainDirs: ['plain'],
  })
  assert.deepEqual(parseManifestRepos(root), ['libs/alpha'])
  assert.ok(warn.mock.callCount() >= 1)
})

test('parseManifestRepos: dedupes by path across manifest and local_manifests, sorted output', (t) => {
  const root = makeTempDir(t, 'diffx-manifest-')
  buildWorkspace(root, {
    manifest: manifestXml('  <project name="alpha" path="libs/alpha"/>\n  <project name="zeta" path="zeta"/>\n'),
    localManifests: { 'extra.xml': '  <project name="alpha" path="libs/alpha"/>\n' },
    repos: ['libs/alpha', 'zeta'],
  })
  assert.deepEqual(parseManifestRepos(root), ['libs/alpha', 'zeta'])
})

// ---------------------------------------------------------------------------
// discoverRepos
// ---------------------------------------------------------------------------

test('discoverRepos: finds depth-1/depth-2 repos, symlinked .git, pruned-dir repo itself; skips pruned descent and non-git dirs; sorted', (t) => {
  const root = makeTempDir(t, 'diffx-discover-')
  buildWorkspace(root, {
    repos: ['depth1', 'nested', 'nested/child', 'node_modules', 'node_modules/x', 'out/x'],
    plainDirs: ['plaindir'],
  })
  // .git as a symlink: target must be a non-bare repo's .git outside root (a bare
  // target fails `git rev-parse --show-toplevel`).
  const symTarget = makeTempDir(t, 'diffx-discover-target-')
  gitInit(join(symTarget, 'target'))
  mkdirSync(join(root, 'symrepo'), { recursive: true })
  symlinkSync(join(symTarget, 'target', '.git'), join(root, 'symrepo', '.git'))

  assert.deepEqual(discoverRepos(root), ['depth1', 'nested', 'nested/child', 'node_modules', 'symrepo'])
})
