# diffx integration tests (workspace mode)

Shell-based API integration tests for multi-repo workspace mode. Independent of
the TS unit tests (`workspace.test.ts`).

## Run

```bash
# Full run: builds fixture, starts servers, asserts 11 test groups
bash test/api.test.sh

# Dry run: builds fixture + lists planned assertions, starts NO server
DRY_RUN=1 bash test/api.test.sh
```

The runner exits 0 on all-pass, 1 on any failure, and always kills the servers
it started (EXIT trap).

## Files

- `fixtures/build-workspace.sh` — idempotent fixture generator. Rebuilds
  `/tmp/diffx-fixture/ws/` from scratch (rm -rf first) and prints the path.
  Also creates bare origin repos under `/tmp/diffx-fixture/origins/` (outside
  the workspace so they are never scanned).
- `api.test.sh` — the test runner.

## Fixture tree (`/tmp/diffx-fixture/ws`)

| Path             | State vs upstream                                              |
|------------------|----------------------------------------------------------------|
| `repoA/`         | 1 unpushed commit (file1.txt), uncommitted rename (file2.txt → renamed2.txt), mode-only change (script.sh +x), untracked notes.txt / img.bin (64 random bytes) / dirX/inner.txt |
| `repoA/nested/`  | Own repo + origin, 1 unpushed commit (nedit.txt, added)        |
| `repoB/`         | 2 unpushed commits (文件.txt edit, other.txt added), staged-only staged.txt |
| `stagedOnly/`    | staged-only change (pending.txt added to index)                |
| `clean/`         | fully synced — must NOT appear in /api/diff or /api/commits     |
| `noUpstream/`    | no remote, working-tree change (local.txt) — absent from /api/commits |
| `notInManifest/` | valid git repo, NOT in manifest — must never appear            |
| `out/`, `node_modules/decoy/.git` | pruning decoys that must not appear           |

Repo list comes from `.repo/manifest.xml` (include `default.xml`) +
`.repo/manifests/default.xml` (repoA, repoB, clean, noUpstream, `gone` missing
on disk, remove-project notInManifest) + `.repo/local_manifests/extra.xml`
(stagedOnly, and `nested` at path `repoA/nested`).

**Nested depth-2 repo:** the manifest path list is authoritative, so
`repoA/nested` is included only because `local_manifests/extra.xml` explicitly
lists `<project name="nested" path="repoA/nested"/>`.

## Assumptions baked into the runner

- Server JSON is compact (`JSON.stringify`, no whitespace); extraction helpers
  grep `"key":"value"` pairs directly.
- `repo` is the first key in /api/commits entries (per contract), so the repoB
  sha is extracted by cutting the string between `"repo":"repoB"` and the next
  `"repo":`.
- oid pairs sent to /api/file-versions are the abbreviated oids from the
  patch `index` lines (contract: "oldOid/newOid come from the patch index
  lines"); if the implementation demands full 40-hex oids, tests 5/8 will 404
  and flag that contract gap.
- DELETE /api/comments/:id may return 200 or 204.
