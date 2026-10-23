import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePatchFiles } from '@pierre/diffs'
import { searchDiff } from '../src/ui/search.js'

const patch = [
  'diff --git a/a.ts b/a.ts',
  'index 1111111..2222222 100644',
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -1,3 +1,4 @@',
  ' const keep = 1',
  '-const oldName = 2',
  '+const newName = 2',
  '+const extra = 3',
  ' const tail = 4',
  '@@ -10,2 +11,3 @@',
  ' const ten = 10',
  '-const oldEleven = 11',
  '+const newEleven = 11',
  '+const addedTwelve = 12',
  '',
].join('\n')

const files = parsePatchFiles(patch).flatMap((entry) => entry.files)

test('finds added and deleted lines with file line numbers', () => {
  const hits = searchDiff(files, 'name')
  assert.deepEqual(
    hits.map((hit) => [hit.side, hit.lineNumber, hit.text]),
    [
      ['deletions', 2, 'const oldName = 2'],
      ['additions', 2, 'const newName = 2'],
    ],
  )
})

test('emits a context line once, on the new-file side', () => {
  const hits = searchDiff(files, 'tail')
  assert.deepEqual(
    hits.map((hit) => [hit.side, hit.lineNumber]),
    [['additions', 4]],
  )
})

test('line numbers account for hunks that start later in the file', () => {
  const hits = searchDiff(files, 'Eleven')
  assert.deepEqual(
    hits.map((hit) => [hit.side, hit.lineNumber]),
    [
      ['deletions', 11],
      ['additions', 12],
    ],
  )

  const context = searchDiff(files, 'ten =')
  assert.deepEqual(
    context.map((hit) => [hit.side, hit.lineNumber]),
    [['additions', 11]],
  )
})

test('is case-insensitive and reports offsets in the original text', () => {
  const hits = searchDiff(files, 'EXtra')
  assert.equal(hits.length, 1)
  assert.equal(hits[0].lineNumber, 3)
  assert.equal(hits[0].text.slice(hits[0].start, hits[0].start + hits[0].length), 'extra')
})

test('returns nothing for an empty query and honors the limit', () => {
  assert.deepEqual(searchDiff(files, '   '), [])
  assert.equal(searchDiff(files, 'const', 2).length, 2)
})
