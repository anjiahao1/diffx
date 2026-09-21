#!/usr/bin/env bash
# Build the diffx multi-repo fixture workspace at /tmp/diffx-fixture/ws.
# Idempotent: removes and rebuilds the whole /tmp/diffx-fixture tree.
# Prints the workspace path on success.
#
# Layout contract (consumed by test/api.test.sh):
# - Every repo with an origin gets a pushed baseline commit first, so @{u}
#   exists; later local commits/edits are local-vs-remote deltas.
# - ws/.repo/manifest.xml + manifests/default.xml + local_manifests/extra.xml
#   are the authoritative repo list. notInManifest/ is a valid git repo NOT
#   listed — it must never appear in API output. nested lives at depth 2
#   (repoA/nested); the top-level manifest lists repoA only, and the
#   manifest path list is authoritative, so nested is explicitly added via
#   local_manifests/extra.xml as <project name="nested" path="repoA/nested"/>.
set -euo pipefail

ROOT=/tmp/diffx-fixture
WS=$ROOT/ws
ORIG=$ROOT/origins

rm -rf "$ROOT"
mkdir -p "$WS" "$ORIG"

# Deterministic identity + dates for every commit.
export GIT_AUTHOR_NAME=Diffx CI GIT_AUTHOR_EMAIL=diffx@example.com
export GIT_COMMITTER_NAME=Diffx CI GIT_COMMITTER_EMAIL=diffx@example.com

# new_repo <name> — create repo with bare origin, commit baseline, push -u.
new_repo() {
  local name=$1
  git init -q --bare "$ORIG/$name.git"
  mkdir -p "$WS/$name"
  git -C "$WS/$name" init -q -b master
  git -C "$WS/$name" remote add origin "$ORIG/$name.git"
}

# commit_in <dir> <date> <msg> — deterministic author/date per commit.
commit_in() {
  GIT_AUTHOR_DATE="$2" GIT_COMMITTER_DATE="$2" git -C "$1" commit -q -m "$3"
}

# ---------------------------------------------------------------------------
# repoA — tracked at origin; unpushed commit + uncommitted edits + untracked.
# ---------------------------------------------------------------------------
new_repo repoA
echo base1 > "$WS/repoA/file1.txt"
echo base2 > "$WS/repoA/file2.txt"
git -C "$WS/repoA" add -A
commit_in "$WS/repoA" "2026-01-01T00:00:01 +0000" "repoA baseline"

# script.sh must exist at upstream so the later chmod is a pure mode-only
# worktree change. Push BEFORE the file1 commit: a push moves the whole
# branch, so anything after this line stays unpushed.
echo "#!/bin/sh" > "$WS/repoA/script.sh"
git -C "$WS/repoA" add script.sh
commit_in "$WS/repoA" "2026-01-01T00:00:03 +0000" "repoA add script"
git -C "$WS/repoA" push -q -u origin master

# Unpushed commit touching one file.
echo edited1 > "$WS/repoA/file1.txt"
git -C "$WS/repoA" add file1.txt
commit_in "$WS/repoA" "2026-01-01T00:00:02 +0000" "repoA unpushed edit file1"

# Uncommitted edit to another file.
echo worktree-edit > "$WS/repoA/file2.txt"

# Pure rename (uncommitted).
git -C "$WS/repoA" mv file2.txt renamed2.txt
echo worktree-edit > "$WS/repoA/renamed2.txt"

# Mode-only change (uncommitted).
chmod +x "$WS/repoA/script.sh"

# Untracked text file + binary + directory. The binary must be deterministic
# (urandom bytes are often NUL-free and then get treated as text).
echo untracked-notes > "$WS/repoA/notes.txt"
{ printf 'BIN\x00'; head -c 60 /dev/zero; printf '\x01\x02\x03'; } > "$WS/repoA/img.bin"
mkdir -p "$WS/repoA/dirX"
echo inner > "$WS/repoA/dirX/inner.txt"

# ---------------------------------------------------------------------------
# repoA/nested — depth-2 nested repo, its own origin + upstream, 1 unpushed.
# ---------------------------------------------------------------------------
new_repo repoA/nested
echo nb > "$WS/repoA/nested/nbase.txt"
git -C "$WS/repoA/nested" add -A
commit_in "$WS/repoA/nested" "2026-01-01T00:00:04 +0000" "nested baseline"
git -C "$WS/repoA/nested" push -q -u origin master
echo nedit > "$WS/repoA/nested/nedit.txt"
git -C "$WS/repoA/nested" add nedit.txt
commit_in "$WS/repoA/nested" "2026-01-01T00:00:05 +0000" "nested unpushed commit"

# ---------------------------------------------------------------------------
# repoB — CJK filename + 2 unpushed commits + a staged-only change.
# ---------------------------------------------------------------------------
new_repo repoB
echo orig > "$WS/repoB/文件.txt"
git -C "$WS/repoB" add -A
commit_in "$WS/repoB" "2026-01-01T00:00:06 +0000" "repoB baseline"
git -C "$WS/repoB" push -q -u origin master

echo first-version > "$WS/repoB/文件.txt"
git -C "$WS/repoB" add 文件.txt
commit_in "$WS/repoB" "2026-01-01T00:00:07 +0000" "repoB unpushed commit one"

echo second-version > "$WS/repoB/other.txt"
git -C "$WS/repoB" add other.txt
commit_in "$WS/repoB" "2026-01-01T00:00:08 +0000" "repoB unpushed commit two"

# Staged-only change (index vs upstream, not committed).
echo staged-content > "$WS/repoB/staged.txt"
git -C "$WS/repoB" add staged.txt

# ---------------------------------------------------------------------------
# stagedOnly — staged change vs upstream, nothing else.
# ---------------------------------------------------------------------------
new_repo stagedOnly
echo s > "$WS/stagedOnly/base.txt"
git -C "$WS/stagedOnly" add -A
commit_in "$WS/stagedOnly" "2026-01-01T00:00:09 +0000" "stagedOnly baseline"
git -C "$WS/stagedOnly" push -q -u origin master
echo staged-only-change > "$WS/stagedOnly/pending.txt"
git -C "$WS/stagedOnly" add pending.txt

# ---------------------------------------------------------------------------
# clean — fully synced, must NOT appear in /api/diff or /api/commits.
# ---------------------------------------------------------------------------
new_repo clean
echo c > "$WS/clean/base.txt"
git -C "$WS/clean" add -A
commit_in "$WS/clean" "2026-01-01T00:00:10 +0000" "clean baseline"
git -C "$WS/clean" push -q -u origin master

# ---------------------------------------------------------------------------
# noUpstream — git repo, no remote; absent from /api/commits.
# ---------------------------------------------------------------------------
mkdir -p "$WS/noUpstream"
git -C "$WS/noUpstream" init -q -b master
echo n > "$WS/noUpstream/base.txt"
echo base > "$WS/noUpstream/local.txt"
git -C "$WS/noUpstream" add -A
commit_in "$WS/noUpstream" "2026-01-01T00:00:11 +0000" "noUpstream baseline"
# tracked modification (not untracked) so the repo shows up in the default
# working-diff fallback without the untracked toggle
echo local-change > "$WS/noUpstream/local.txt"

# ---------------------------------------------------------------------------
# repoM — repo-tool style: detached HEAD, no upstream; the manifest ref
# refs/remotes/m/dev is the diff base. Push WITHOUT -u so no upstream exists.
# ---------------------------------------------------------------------------
new_repo repoM
echo mb > "$WS/repoM/base.txt"
git -C "$WS/repoM" add -A
commit_in "$WS/repoM" "2026-01-01T00:00:14 +0000" "repoM baseline"
git -C "$WS/repoM" push -q origin master
git -C "$WS/repoM" update-ref refs/remotes/m/dev HEAD
git -C "$WS/repoM" checkout -q --detach HEAD
echo msecond > "$WS/repoM/second.txt"
git -C "$WS/repoM" add -A
commit_in "$WS/repoM" "2026-01-01T00:00:15 +0000" "repoM detached local commit"

# ---------------------------------------------------------------------------
# notInManifest — valid git repo, deliberately absent from the manifest.
# ---------------------------------------------------------------------------
mkdir -p "$WS/notInManifest"
git -C "$WS/notInManifest" init -q -b master
echo x > "$WS/notInManifest/base.txt"
git -C "$WS/notInManifest" add -A
commit_in "$WS/notInManifest" "2026-01-01T00:00:12 +0000" "notInManifest baseline"

# ---------------------------------------------------------------------------
# Repo-manifest files (authoritative repo list).
# ---------------------------------------------------------------------------
mkdir -p "$WS/.repo/manifests" "$WS/.repo/local_manifests"
cat > "$WS/.repo/manifest.xml" <<'EOF'
<manifest>
  <include name="default.xml"/>
</manifest>
EOF
cat > "$WS/.repo/manifests/default.xml" <<'EOF'
<manifest>
  <default/>
  <remote/>
  <project name="repoA" path="repoA"/>
  <project name="repoB" path="repoB"/>
  <project name="clean" path="clean"/>
  <project name="noUpstream" path="noUpstream"/>
  <project name="gone" path="gone"/>
  <remove-project name="notInManifest"/>
</manifest>
EOF
cat > "$WS/.repo/local_manifests/extra.xml" <<'EOF'
<manifest>
  <project name="stagedOnly" path="stagedOnly"/>
  <project name="nested" path="repoA/nested"/>
  <project name="repoM" path="repoM"/>
</manifest>
EOF

# ---------------------------------------------------------------------------
# Decoys that pruning must skip: junk output dir + fake node_modules .git.
# ---------------------------------------------------------------------------
mkdir -p "$WS/out" "$WS/node_modules/decoy/.git"
echo junk > "$WS/out/junk.txt"
echo decoy > "$WS/node_modules/decoy/fake.txt"

echo "$WS"
