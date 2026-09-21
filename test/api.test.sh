#!/usr/bin/env bash
# Integration tests for diffx multi-repo workspace mode.
#
# Usage:
#   DRY_RUN=1 test/api.test.sh   # build fixture + list planned assertions, no server
#   test/api.test.sh             # full run: fixture + server + all assertions
#
# Requires: git, curl, sed, grep, awk. No jq/python dependency.
# JSON is assumed compact (JSON.stringify, no added whitespace) — extraction
# helpers below grep key/value pairs directly and fail loudly otherwise.
set -euo pipefail

DIFFX_ROOT=$(cd "$(dirname "$0")/.." && pwd)
FIXTURE=/tmp/diffx-fixture/ws
CACHE_DIR=$HOME/.diffx/cache/-tmp-diffx-fixture-ws
TMP=$(mktemp -d)
PASS=0 FAIL=0
SERVER_PID=
BASE=

command -v curl >/dev/null || { echo "curl is required"; exit 2; }
command -v git  >/dev/null || { echo "git is required";  exit 2; }

cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  [ -n "$SERVER_PID" ] && wait "$SERVER_PID" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Pass/fail helpers
# ---------------------------------------------------------------------------
ok() { PASS=$((PASS+1)); echo "PASS: $1"; }
fail_test() { # name expected got
  FAIL=$((FAIL+1))
  echo "FAIL: $1"
  echo "  expected: $2"
  echo "  got:      $(printf '%s' "${3:-<empty>}" | head -c 300)"
}
snippet() { printf '%s' "$1" | head -c 200; }

expect_contains() { # name haystack needle
  if printf '%s' "$2" | grep -qF -- "$3"; then ok "$1"
  else fail_test "$1" "contains [$3]" "$(snippet "$2")"; fi
}
expect_absent() { # name haystack needle
  if printf '%s' "$2" | grep -qF -- "$3"; then fail_test "$1" "absent [$3]" "$(snippet "$2")"
  else ok "$1"; fi
}
expect_status() { # name expected_status
  if [ "$STATUS" = "$2" ]; then ok "$1"
  else fail_test "$1" "HTTP $2" "HTTP $STATUS body=$(snippet "$BODY")"; fi
}

# ---------------------------------------------------------------------------
# HTTP helper — sets STATUS and BODY globals
# ---------------------------------------------------------------------------
req() { # req <path> [method] [json-data]
  local path=$1 method=${2:-GET} data=${3:-}
  local args=(-s -o "$TMP/body" -w '%{http_code}' -X "$method" --max-time 30)
  [ -n "$data" ] && args+=(-H 'content-type: application/json' -d "$data")
  STATUS=$(curl "${args[@]}" "$BASE$path")
  BODY=$(cat "$TMP/body")
}

# start_server <dir> [extra args...] — background server, poll until 200.
start_server() {
  local dir=$1; shift
  local port=$((3434 + RANDOM % 100)) i code
  ( cd "$dir" && "$DIFFX_ROOT/node_modules/.bin/tsx" \
      "$DIFFX_ROOT/src/cli.ts" --no-open -p "$port" "$@" ) >"$TMP/server.log" 2>&1 &
  SERVER_PID=$!
  for i in $(seq 1 50); do # ~10s
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 \
      "http://127.0.0.1:$port/api/diff" 2>/dev/null || true)
    if [ "$code" = "200" ]; then BASE="http://127.0.0.1:$port"; return 0; fi
    sleep 0.2
  done
  echo "ERROR: server did not become ready on port $port; log:" >&2
  cat "$TMP/server.log" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# Patch extraction helpers (operate on the compact-JSON response BODY)
# ---------------------------------------------------------------------------
# patch.txt = JSON body with \n escapes turned into real newlines (patch view).
# The leading {"patch":" is stripped so the first diff --git starts a line.
to_patch_text() { printf '%s' "$BODY" | sed -e 's/^{"patch":"//' -e 's/\\n/\n/g' > "$TMP/patch.txt"; }

# index line oids for repoA/file1.txt from patch.txt -> FIRST_OLD FIRST_NEW
extract_first_oids() {
  local line
  line=$(grep -A6 -m1 '^diff --git a/repoA/file1.txt' "$TMP/patch.txt" | grep -m1 '^index ' || true)
  FIRST_OLD=$(printf '%s' "$line" | sed 's/^index \([0-9a-f]*\)\.\..*/\1/')
  FIRST_NEW=$(printf '%s' "$line" | sed 's/^index [0-9a-f]*\.\.\([0-9a-f]*\).*/\1/')
}

# first added file (index 0000000..) -> ADD_PATH ADD_NEWOID
extract_added_file() {
  ADD_NEWOID=$(grep -m1 '^index 0000000' "$TMP/patch.txt" | sed 's/^index 0000000\.\.\([0-9a-f]*\).*/\1/')
  ADD_PATH=$(grep -A4 -m1 '^index 0000000' "$TMP/patch.txt" | grep -m1 '^+++ b/' | sed 's|^+++ b/||')
}

# oldest (first-made) unpushed sha under "repo":"repoB" in /api/commits JSON.
# git log lists newest first, so the wanted sha is the LAST one in the section.
extract_repob_sha() {
  local section
  section=$(printf '%s' "$BODY" | sed 's/.*"repo":"repoB"//' | sed 's/"repo":.*//')
  REPOB_SHA1=$(printf '%s' "$section" | grep -o '"sha":"[0-9a-f]\{40\}"' | tail -1 | sed 's/"sha":"//;s/"//' || true)
}

# first comment id in GET /api/comments JSON -> COMMENT_ID
extract_comment_id() {
  COMMENT_ID=$(printf '%s' "$BODY" | grep -o '"id":"\?[0-9a-zA-Z-]*"\?' | head -1 | sed 's/"id":"\?//;s/"\?$//' || true)
}

# ---------------------------------------------------------------------------
# DRY RUN: fixture only, no server
# ---------------------------------------------------------------------------
if [ "${DRY_RUN:-0}" = "1" ]; then
  echo "DRY_RUN: building fixture (no server will be started)"
  WS_PATH=$("$DIFFX_ROOT/test/fixtures/build-workspace.sh")
  echo "DRY_RUN: fixture at $WS_PATH"
  echo "DRY_RUN: planned assertions (executed only without DRY_RUN=1):"
  cat <<'EOF'
  1. /api/diff defaults: prefixed paths a/repoA + b/repoA, repoA/nested file,
     repoB CJK filename raw (no \346 octal), stagedOnly change without staged
     param, repoB unpushed-commit content, clean/notInManifest absent,
     repos metadata has repoA/repoB/stagedOnly/noUpstream not clean,
     repoName = ws, branch = ''
  2. /api/diff?untracked=true: repoA/notes.txt +++ with + lines,
     binaryFiles has repoA/img.bin type untracked
  3. /api/commits: repoB exactly 2 commits w/ expected subjects, nested under
     repoA/nested, noUpstream absent, clean absent/empty, shas 40-hex
  4. /api/diff?commit=<repoB sha1>&repo=repoB: only that commit's CJK change
     with b/repoB/ prefix, single-file patch
  5. /api/file-versions: real index oid pair 200 + old/new differ; unprefixed
     path 404; ../etc/passwd 404; zero oldOid added file 200 old:""
  6. /api/file-content: prefixed untracked binary 200 + octet-stream,
     ../../etc/passwd 404
  7. /api/review-status GET/POST roundtrip
  8. comments: POST w/ repo+commitSha+fileOid -> 201, persisted to
     ~/.diffx/cache/-tmp-diffx-fixture-ws/comments.json, patchsets.json with
     oldOid/newOid, /api/patchset-diff 200, unknown commit 404, DELETE cleanup
  9. --repo repoA: repoA paths only, no repoB
 10. -- HEAD~1: 200 + repoB last commit content present
 11. single-repo (inside repoA): no prefix, repoName=repoA, branch non-empty,
     /api/commits repo:'' with repoA unpushed commit
EOF
  echo "SERVER NOT STARTED BY THIS DRY-RUN"
  exit 0
fi

# ---------------------------------------------------------------------------
# Build fixture + fresh comment cache
# ---------------------------------------------------------------------------
echo "== building fixture =="
WS_PATH=$("$DIFFX_ROOT/test/fixtures/build-workspace.sh")
echo "fixture: $WS_PATH"
rm -rf "$CACHE_DIR"

# ===========================================================================
echo "== 1. /api/diff (workspace defaults) =="
start_server "$FIXTURE"
req "/api/diff"
expect_status "GET /api/diff" 200
expect_contains "patch has a/repoA/ prefix" "$BODY" '--- a/repoA/'
expect_contains "patch has b/repoA/ prefix" "$BODY" '+++ b/repoA/'
expect_contains "nested repo file present"  "$BODY" 'repoA/nested/nedit.txt'
expect_contains "CJK filename raw"          "$BODY" '文件.txt'
expect_absent   "CJK not octal-escaped"     "$BODY" '\346'
expect_contains "stagedOnly change w/o staged param" "$BODY" 'stagedOnly/pending.txt'
expect_contains "repoB unpushed commit content (local-vs-remote)" "$BODY" 'second-version'
expect_contains "repoM manifest-base diff (detached HEAD)" "$BODY" 'msecond'
expect_absent   "clean absent"        "$BODY" '"relPath":"clean"'
expect_absent   "clean paths absent"  "$BODY" 'b/clean/'
expect_absent   "notInManifest absent" "$BODY" 'notInManifest'
expect_contains "repos metadata repoA"        "$BODY" '"relPath":"repoA"'
expect_contains "repos metadata repoB"        "$BODY" '"relPath":"repoB"'
expect_contains "repos metadata stagedOnly"   "$BODY" '"relPath":"stagedOnly"'
expect_contains "repos metadata noUpstream"   "$BODY" '"relPath":"noUpstream"'
expect_contains "repoName = workspace basename" "$BODY" '"repoName":"ws"'
expect_contains "branch empty in workspace mode" "$BODY" '"branch":""'
# ===========================================================================
echo "== 2. /api/diff?untracked=true =="
req "/api/diff?untracked=true"
expect_status "GET /api/diff?untracked=true" 200
expect_contains "untracked text file +++ line" "$BODY" '+++ b/repoA/notes.txt'
expect_contains "untracked file has + lines"   "$BODY" '\n+untracked-notes'
expect_contains "untracked dir file"           "$BODY" 'repoA/dirX/inner.txt'
expect_contains "binaryFiles untracked img.bin" "$BODY" '"path":"repoA/img.bin","type":"untracked"'
expect_contains "untrackedFiles lists notes.txt" "$BODY" '"untrackedFiles":["repoA/dirX/inner.txt","repoA/img.bin","repoA/notes.txt"'

# ===========================================================================
echo "== 3. /api/commits =="
req "/api/commits"
expect_status "GET /api/commits" 200
COMMITS_JSON=$BODY
# repoB section: string from "repo":"repoB" up to the next "repo": entry
REPOB_SECTION=$(printf '%s' "$COMMITS_JSON" | sed 's/.*"repo":"repoB"//' | sed 's/"repo":.*//')
echo "$REPOB_SECTION" > "$TMP/repob.json"
N_SUBJ=$(grep -o '"subject":"[^"]*"' "$TMP/repob.json" | wc -l || true)
if [ "$N_SUBJ" = "2" ]; then ok "repoB has exactly 2 commits"
else fail_test "repoB has exactly 2 commits" "2 subjects" "$N_SUBJ subjects: $(snippet "$REPOB_SECTION")"; fi
expect_contains "repoB commit one subject" "$REPOB_SECTION" 'repoB unpushed commit one'
expect_contains "repoB commit two subject" "$REPOB_SECTION" 'repoB unpushed commit two'
expect_contains "nested listed under repoA/nested" "$COMMITS_JSON" '"repo":"repoA/nested"'
expect_contains "repoM commits via manifest base" "$COMMITS_JSON" '"repo":"repoM"'
expect_contains "repoM branch label from manifest ref" "$COMMITS_JSON" '"branch":"dev"'
expect_absent   "noUpstream absent from commits" "$COMMITS_JSON" '"repo":"noUpstream"'
if printf '%s' "$COMMITS_JSON" | grep -qF '"repo":"clean"'; then
  CLEAN_SECTION=$(printf '%s' "$COMMITS_JSON" | sed 's/.*"repo":"clean"//' | sed 's/"repo":.*//')
  N_CLEAN=$(printf '%s' "$CLEAN_SECTION" | grep -o '"sha":"' | wc -l || true)
  if [ "$N_CLEAN" = "0" ]; then ok "clean present but commit-less (or absent)"
  else fail_test "clean has no commits" "0 commits" "$N_CLEAN commits"; fi
else
  ok "clean present but commit-less (or absent)"
fi
ALL_SHAS=$(printf '%s' "$COMMITS_JSON" | grep -o '"sha":"[0-9a-f]\{40\}"' | wc -l || true)
ALL_SHA_LIKE=$(printf '%s' "$COMMITS_JSON" | grep -o '"sha":"[^"]*"' | wc -l || true)
if [ "$ALL_SHAS" = "$ALL_SHA_LIKE" ] && [ "$ALL_SHA_LIKE" -gt 0 ]; then
  ok "all shas are 40-hex"
else
  fail_test "all shas are 40-hex" "every sha 40-hex" "$ALL_SHAS/$ALL_SHA_LIKE 40-hex"
fi

# ===========================================================================
echo "== 4. /api/diff?commit=<repoB sha1>&repo=repoB =="
extract_repob_sha
if [ -z "${REPOB_SHA1:-}" ]; then
  fail_test "extract repoB sha1" "40-hex sha" "empty"
else
  req "/api/diff?commit=$REPOB_SHA1&repo=repoB"
  expect_status "commit view 200" 200
  expect_contains "commit view has b/repoB/ prefix" "$BODY" 'b/repoB/'
  expect_contains "commit view has CJK file" "$BODY" '文件.txt'
  expect_contains "commit view has that commit's content" "$BODY" 'first-version'
  expect_absent   "commit view excludes other commit's content" "$BODY" 'second-version'
  expect_absent   "commit view excludes repoA files" "$BODY" 'repoA/'
  to_patch_text
  N_FILES=$(grep -c '^diff --git' "$TMP/patch.txt" || true)
  if [ "$N_FILES" = "1" ]; then ok "commit view is a single-file patch"
  else fail_test "commit view is a single-file patch" "1 diff --git" "$N_FILES"; fi
fi

# ===========================================================================
echo "== 5. /api/file-versions =="
req "/api/diff"
to_patch_text
extract_first_oids
if [ -z "${FIRST_OLD:-}" ] || [ -z "${FIRST_NEW:-}" ]; then
  fail_test "extract index oid pair from patch" "index <old>..<new>" "none found"
else
  req "/api/file-versions?path=repoA/file1.txt&oldOid=$FIRST_OLD&newOid=$FIRST_NEW"
  expect_status "file-versions with real oid pair (prefixed path)" 200
  expect_contains "file-versions old is base content" "$BODY" '"old":"base1'
  expect_contains "file-versions new is edited content" "$BODY" '"new":"edited1'
  req "/api/file-versions?path=file1.txt&oldOid=$FIRST_OLD&newOid=$FIRST_NEW"
  expect_status "file-versions unprefixed path -> 404" 404
  req "/api/file-versions?path=repoA/../../../etc/passwd&oldOid=$FIRST_OLD&newOid=$FIRST_NEW"
  expect_status "file-versions path traversal -> 404" 404
fi
extract_added_file
if [ -z "${ADD_NEWOID:-}" ] || [ -z "${ADD_PATH:-}" ]; then
  fail_test "extract added file (zero oldOid)" "index 0000000.. pair + path" "none found"
else
  req "/api/file-versions?path=$(printf '%s' "$ADD_PATH" | sed 's|/|%2F|g')&oldOid=0000000000000000000000000000000000000000&newOid=$ADD_NEWOID"
  expect_status "file-versions zero oldOid for added file" 200
  expect_contains "added file old side empty" "$BODY" '"old":""'
fi
# ===========================================================================
echo "== 6. /api/file-content =="
req "/api/diff?untracked=true"   # ensure untracked binary is in current diff
code=$(curl -s -o "$TMP/img.bin" -w '%{http_code}' -D "$TMP/img.headers" \
  "$BASE/api/file-content?path=repoA/img.bin&version=new")
if [ "$code" = "200" ] && [ -s "$TMP/img.bin" ]; then ok "untracked binary file-content 200 + non-empty"
else fail_test "untracked binary file-content 200 + non-empty" "200, non-empty" "$code, $(wc -c < "$TMP/img.bin") bytes"; fi
if grep -qi '^content-type: application/octet-stream' "$TMP/img.headers"; then
  ok "binary content-type octet-stream"
else
  fail_test "binary content-type octet-stream" "application/octet-stream" "$(head -5 "$TMP/img.headers")"
fi
req "/api/file-content?path=../../etc/passwd&version=new"
expect_status "file-content traversal -> 404" 404

# ===========================================================================
echo "== 7. /api/review-status roundtrip =="
req "/api/review-status"
expect_status "GET review-status" 200
expect_contains "initial done:false" "$BODY" '"done":false'
expect_contains "counts present" "$BODY" '"counts"'
req "/api/review-status" POST '{"done":true}'
expect_status "POST review-status" 200
expect_contains "after POST done:true" "$BODY" '"done":true'
req "/api/review-status"
expect_contains "GET reflects done:true" "$BODY" '"done":true'
req "/api/review-status" POST '{"done":false}'
expect_contains "reset to done:false" "$BODY" '"done":false'

# ===========================================================================
echo "== 8. comments + patchsets (R4) =="
# Capture the repoB commit-view patch and its first new-blob oid.
req "/api/diff?commit=$REPOB_SHA1&repo=repoB"
to_patch_text
FILE_OID=$(grep -m1 '^index ' "$TMP/patch.txt" | sed 's/^index [0-9a-f]*\.\.\([0-9a-f]*\).*/\1/')
if [ -z "$FILE_OID" ]; then fail_test "capture fileOid from commit-view patch" "oid" "empty"; fi
# 文件.txt URL-encoding: 文=%E6%96%87 件=%E4%BB%B6
req "/api/comments" POST "{\"filePath\":\"repoB/文件.txt\",\"side\":\"additions\",\"lineNumber\":1,\"lineContent\":\"first-version\",\"body\":\"integration test comment\",\"repo\":\"repoB\",\"commitSha\":\"$REPOB_SHA1\",\"fileOid\":\"$FILE_OID\"}"
expect_status "POST comment 201" 201
req "/api/comments"
expect_contains "GET comments returns it" "$BODY" 'integration test comment'
if [ ! -f "$CACHE_DIR/comments.json" ]; then
  fail_test "comments.json persisted" "file exists at $CACHE_DIR/comments.json" "missing"
else
  ok "comments.json persisted"
  expect_contains "comments.json contains the comment" "$(cat "$CACHE_DIR/comments.json")" 'integration test comment'
fi
if [ ! -f "$CACHE_DIR/patchsets.json" ]; then
  fail_test "patchsets.json persisted" "file exists at $CACHE_DIR/patchsets.json" "missing"
else
  PS_JSON=$(cat "$CACHE_DIR/patchsets.json")
  expect_contains "patchsets.json has files map keyed by path" "$PS_JSON" '"文件.txt"'
  expect_contains "patchsets.json has newOid" "$PS_JSON" '"newOid"'
  expect_contains "patchsets.json has oldOid" "$PS_JSON" '"oldOid"'
fi
if [ -n "$FILE_OID" ]; then
  code=$(curl -s -o "$TMP/psbody" -w '%{http_code}' --get \
    --data-urlencode "repo=repoB" --data-urlencode "commit=$REPOB_SHA1" \
    --data-urlencode "path=文件.txt" "$BASE/api/patchset-diff")
  if [ "$code" = "200" ] && grep -q '"patch"' "$TMP/psbody"; then
    ok "patchset-diff 200 with patch key"
  else
    fail_test "patchset-diff 200 with patch key" "200 + \"patch\"" "$code body=$(head -c 200 "$TMP/psbody")"
  fi
fi
code=$(curl -s -o /dev/null -w '%{http_code}' --get \
  --data-urlencode "repo=repoB" --data-urlencode "commit=0000000000000000000000000000000000000000" \
  --data-urlencode "path=文件.txt" "$BASE/api/patchset-diff")
if [ "$code" = "404" ]; then ok "patchset-diff unknown commit 404"
else fail_test "patchset-diff unknown commit 404" "404" "$code"; fi

req "/api/comments"
extract_comment_id
if [ -z "$COMMENT_ID" ]; then
  fail_test "extract comment id" "id field" "none"
else
  req "/api/comments/$COMMENT_ID" DELETE
  case "$STATUS" in 200|204) ok "DELETE comment";; *) fail_test "DELETE comment" "200/204" "$STATUS";; esac
  req "/api/comments"
  expect_absent "comment gone after DELETE" "$BODY" 'integration test comment'
fi
rm -rf "$CACHE_DIR"

# ===========================================================================
echo "== 9. --repo repoA filter =="
kill "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true; SERVER_PID=
start_server "$FIXTURE" --repo repoA
req "/api/diff"
expect_status "GET /api/diff (--repo repoA)" 200
expect_contains "repoA paths present" "$BODY" '+++ b/repoA/'
expect_absent   "repoB filtered out" "$BODY" 'b/repoB/'
expect_absent   "repoB metadata filtered" "$BODY" '"relPath":"repoB"'
expect_absent   "stagedOnly filtered" "$BODY" '"relPath":"stagedOnly"'

# ===========================================================================
echo "== 10. custom diff args: -- HEAD~1 =="
kill "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true; SERVER_PID=
start_server "$FIXTURE" -- HEAD~1
req "/api/diff"
expect_status "GET /api/diff (custom args)" 200
expect_contains "repoB last-commit content present" "$BODY" 'second-version'

# ===========================================================================
echo "== 11. single-repo regression (inside repoA) =="
kill "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true; SERVER_PID=
start_server "$FIXTURE/repoA"
req "/api/diff"
expect_status "GET /api/diff (single repo)" 200
expect_absent   "no repoA/ prefix on paths" "$BODY" 'a/repoA/'
expect_contains "paths unprefixed" "$BODY" '+++ b/renamed2.txt'
expect_contains "repoName = repoA" "$BODY" '"repoName":"repoA"'
BRANCH=$(printf '%s' "$BODY" | grep -o '"branch":"[^"]*"' | head -1 | sed 's/"branch":"//;s/"$//' || true)
if [ -n "$BRANCH" ]; then ok "branch non-empty ($BRANCH)"
else fail_test "branch non-empty" "branch name" "empty"; fi
req "/api/commits"
expect_contains "commits repo field empty" "$BODY" '"repo":""'
expect_contains "repoA unpushed commit listed" "$BODY" 'repoA unpushed edit file1'

# ===========================================================================
echo
echo "passed=$PASS failed=$FAIL"
[ "$FAIL" -eq 0 ]
