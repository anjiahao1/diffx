# diffx

A local code review tool designed for the coding agent workflow. Review AI-generated changes in a GitHub PR-like web UI, leave inline comments, then hand them back to your coding agent to fix.

![screenshot](https://raw.githubusercontent.com/anjiahao1/diffx/main/screenshot.png)

## Install

> The npm package `diffx-cli` is the upstream release. This fork is not
> published to npm — install it by cloning the repository.

### Manual install (CLI)

```bash
git clone https://github.com/anjiahao1/diffx.git
cd diffx
corepack pnpm install
corepack pnpm run build
npm install -g .
```

Verify with `diffx --version`. Not using corepack? Use `npx pnpm` in place of
`corepack pnpm`, or install pnpm first (`npm install -g pnpm`).

### Installing for your AI agent

Give your coding agent these steps and it sets diffx up by itself:

1. **Install the CLI** (skip when `which diffx` already succeeds):

   ```bash
   git clone https://github.com/anjiahao1/diffx.git "$HOME/.diffx/src"
   cd "$HOME/.diffx/src"
   corepack pnpm install && corepack pnpm run build
   npm install -g .
   ```

2. **Install the skills** (`/diffx-start-review`, `/diffx-finish-review`), e.g.
   for Claude Code:

   ```bash
   mkdir -p "$HOME/.claude/skills"
   ln -sfn "$HOME/.diffx/src/skills/diffx-start-review" "$HOME/.claude/skills/diffx-start-review"
   ln -sfn "$HOME/.diffx/src/skills/diffx-finish-review" "$HOME/.claude/skills/diffx-finish-review"
   ```

   (If you use the skills CLI instead: `npx skills add anjiahao1/diffx`.)

3. **Verify**: `diffx --version` prints a version, and the
   `/diffx-start-review` slash command is available in your agent.

## Usage

Run in any git repository:

```bash
diffx
```

This starts a local server (listening on `0.0.0.0` by default, so other machines on the LAN can review too) and opens your browser with a diff review UI.

### Options

```
diffx [options] [-- <git-diff-args>]

Options:
  -p, --port <port>   Port to run the server on (default: random available port)
  --host <host>       Host address to bind to (default: 0.0.0.0, exposing the
                      server to the local network). Pass 127.0.0.1 to restrict
                      it to this machine.
  --multi [dir]       Multi-repo workspace mode: aggregate diffs from every git
                      repository under dir (default: current directory). Also
                      entered automatically when the current directory is not a
                      git repository but contains repositories.
  --repo <name>       Only review matching repositories (repeatable; matches the
                      repo path relative to the workspace, suffix match allowed).
  --no-open           Don't open the browser automatically
  -v, --version       Show version number
  -h, --help          Show this help message

Examples:
  diffx                          # Review uncommitted changes
  diffx -- HEAD~3                # Review last 3 commits
  diffx -- main..feature         # Compare branches
  diffx --multi                  # Review every repo under the current workspace
  diffx --multi ~/ws --repo nuttx --repo apps
  diffx --host 127.0.0.1         # Restrict the server to this machine only
```

### Multi-repo workspaces

Point `--multi` at a workspace root (e.g. a repo-tool checkout) to review all
git repositories under it in one session — useful for firmware/BSP trees where
a change spans several repos:

```bash
diffx --multi ~/workspace --repo vendor/bes --repo nuttx --repo apps
```

- The sidebar lists **Unpushed commits** per repo; click one to review just
  that commit's diff, or click **All changes** in the toolbar to return to the
  full workspace diff.
- Workspace mode diffs against each repo's upstream or manifest base, so the
  full local delta (local commits plus uncommitted changes) is shown at once.

## Features

- **Split / Unified view** — Toggle between side-by-side and inline diff
- **Syntax highlighting** — Powered by Shiki with GitHub themes
- **File tree** — Hierarchical file browser with search filter and file change-type icons
- **Inline comments** — Click the `+` button on any line to add a review comment
- **Column-anchored comments** — Select a stretch of text in a line, then click `+`: the comment pins to the character range and quotes the selection
- **Commit-message comments** — In the per-commit view, comment on the commit message itself from the header card
- **Per-commit review** — Sidebar "Unpushed commits" list; each commit opens its own diff and comments anchor to that commit (with "diff since comment" built from a blob snapshot)
- **Note to the AI** — Sidebar "Note to the AI" input, persisted per review, emitted as `<ai-instructions>` ahead of copied comments
- **Comment replies** — AI agents can reply to comments via API, displayed with bot avatar in the UI
- **Comment status tracker** — Sidebar widget showing open, replied, and resolved comment counts; clicking a comment jumps to it (switching to its commit view when needed)
- **Copy comments** — One-click copy all comments as structured XML for AI coding agents
- **Image preview** — Side-by-side comparison for added, modified, and deleted images
- **Viewed tracking** — Mark files as reviewed to track progress
- **Staged / Untracked toggles** — Choose which changes to include
- **Custom diff commands** — Pass any `git diff` arguments after `--`
- **EditorConfig support** — Respects `.editorconfig` for per-file tab size
- **Persistent settings** — Your preferences are saved across sessions

## Comment Output Format

When you click "Copy comments", the output is structured XML optimized for AI agents:

```xml
<ai-instructions>Please focus on the concurrency changes.</ai-instructions>

<code-review-comments>
<file path="src/utils/parser.ts" commit="repo-01@abc1234">
<comment line="42" column="10-22">
<code>+ const parsedToken = tokenize(input)</code>
Rename `x` to `parsedToken` for clarity.
</comment>
<comment line="15">
<code>- if (input != null) {</code>
This null check removal may cause a bug when `input` is undefined.
</comment>
</file>
</code-review-comments>
```

Each comment includes the commented code line with a `+`/`-` prefix indicating
whether it's an added or removed line; a `column` attribute narrows the comment
to a selected stretch of the line, and `commit` tells the agent which commit a
comment anchors to.

## Agent Skills

Install the diffx skills to use diffx directly from your AI coding agent:

```bash
npx skills add anjiahao1/diffx
```

The review workflow uses two commands:

1. **`/diffx-start-review`** — Launches the diffx server and opens the browser. Review your changes and leave inline comments.
2. **`/diffx-finish-review`** — The agent fetches all comments from the running diffx server via API, applies the requested changes, and marks each comment as resolved. The browser UI updates in real time as comments are resolved.

## License

MIT