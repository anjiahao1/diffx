---
name: diffx-start-review
description: "Start a code review session by launching the diffx server and opening the browser UI. Use when the user invokes /diffx-start-review."
user_invocable: true
---

# Start diffx Review

Launch the diffx server so the user can review their git changes in a browser-based UI and leave inline comments.

## What to do

### 1. Launch diffx

**Prefer multi-repo workspace mode** (`--multi` + `--repo`). It aggregates every git repo under a workspace root (repo-tool manifest or fs scan) and narrows the review to the repos actually being worked on:

```bash
diffx --multi /path/to/workspace                    # Every repo under the workspace root
diffx --multi /path/to/workspace --repo nuttx       # Only matching repos
diffx --multi /path/to/workspace --repo nuttx --repo apps/netutils   # Repeatable, suffix match
```

- `--repo <name>` matches the repo path relative to the workspace root (suffix match allowed) and is repeatable.
- Omit the dir to use the current directory as the workspace root.
- If the user names the repos they touched, pass each as `--repo`; otherwise launch without it.

Single-repo mode is the fallback when the context is one plain git repo (no workspace). Default shows all working tree changes (staged + unstaged + untracked):

```bash
diffx
```

Common variations — use these when the context calls for it:

```bash
diffx -- --staged          # Only staged changes
diffx -- HEAD~3            # Last 3 commits
diffx -- main..HEAD        # Current branch vs main
diffx -p 8080              # Custom port (default: random available port)
```

Anything after `--` is passed directly to `git diff`, so any valid git diff arguments work.

**Important:** Run diffx in the background using the Bash tool with `run_in_background: true`, so the server stays alive while the user reviews.

### 2. Watch for review completion

Start a persistent background watcher so you are notified every time the
user finishes a review round. Run this with the Bash tool
(`run_in_background: true`), replacing `<port>` with the port diffx reported
on startup:

```bash
while true; do
  # wait until the user clicks "Done Review"
  until curl -sf http://localhost:<port>/api/review-status | grep -q '"done":true'; do sleep 3; done
  echo "REVIEW_DONE"
  # wait until "Done Review" is un-clicked, so the next round can trigger again
  until curl -sf http://localhost:<port>/api/review-status | grep -q '"done":false'; do sleep 3; done
done
```

Each `REVIEW_DONE` line means the user clicked **Done Review** for that
round: proceed through the `/diffx-finish-review` flow (fetch comments via
the API, apply the requested changes, resolve each comment) without waiting
for the user to come back and say so. After you finish, the watcher keeps
running — if the user reviews again (clicking Done Review once more), you
get notified again and repeat the flow. The watcher survives rounds; only
stop it when the whole review session is over.

### 3. Tell the user

After launching, tell the user:

> diffx is running. Review your changes in the browser and leave inline comments. When you're done, click **Done Review** and I'll process your comments automatically.

Keep it brief.
