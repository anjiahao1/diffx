#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import getPort from 'get-port'
import { isGitRepo } from './git.js'
import { discoverWorkspace } from './workspace.js'
import { startServer } from './server.js'
import type { WorkspaceContext } from './server.js'
import { loadSettings } from './settings.js'

// node:util parseArgs cannot express a string flag with an optional value, so
// pre-scan argv for `--multi [dir]`: the dir is the token right after --multi
// when it does not start with `-` and comes before the `--` terminator.
// Scanned tokens are removed before parseArgs sees the rest.
function scanMulti(argv: string[]): { multi: boolean; dir?: string; rest: string[] } {
  const rest: string[] = []
  let multi = false
  let dir: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') {
      rest.push(...argv.slice(i))
      break
    }
    if (arg === '--multi') {
      multi = true
      const next = argv[i + 1]
      if (next && !next.startsWith('-')) {
        dir = next
        i++
      }
      continue
    }
    rest.push(arg)
  }
  return { multi, dir, rest }
}

const scanned = scanMulti(process.argv.slice(2))

const { values, positionals } = parseArgs({
  options: {
    port: { type: 'string', short: 'p' },
    host: { type: 'string' },
    multi: { type: 'boolean', default: false },
    repo: { type: 'string', multiple: true },
    'no-open': { type: 'boolean', default: false },
    help: { type: 'boolean' },
    version: { type: 'boolean', short: 'v' },
  },
  args: scanned.rest,
  allowPositionals: true,
})

if (values.help) {
  console.log(`diffx - Local code review tool for git diffs

Usage: diffx [options] [-- <git diff args>]

Options:
  -p, --port <port>  Port to run the server on (default: random available port)
  --host <host>      Host address to bind to (default: 0.0.0.0, exposing the
                     server to the local network). Pass 127.0.0.1 to restrict
                     it to this machine.
  --multi [dir]      Multi-repo workspace mode: aggregate diffs from every git
                     repository under dir (default: current directory). Also
                     entered automatically when the current directory is not a
                     git repository but contains repositories.
  --repo <name>      Only review matching repositories (repeatable; matches the
                     repo path relative to the workspace, suffix match allowed).
  --no-open          Don't open the browser automatically
  -v, --version      Show version number
  -h, --help         Show this help message

Examples:
  diffx                        Review uncommitted changes
  diffx -- HEAD~3              Review last 3 commits
  diffx -- main..feature       Compare branches
  diffx --multi                Review every repo under the current workspace
  diffx --multi ~/ws --repo nuttx --repo apps
  diffx --host 127.0.0.1       Restrict the server to this machine only`)
  process.exit(0)
}

if (values.version) {
  const __dirname = dirname(fileURLToPath(import.meta.url))
  const pkg = JSON.parse(readFileSync(resolve(__dirname, '..', 'package.json'), 'utf-8'))
  console.log(pkg.version)
  process.exit(0)
}

// Everything after -- becomes custom git diff args
const customDiffArgs = positionals.length > 0 ? positionals : undefined

// Mode selection: --multi forces workspace mode; otherwise a git cwd is
// single-repo (unchanged behavior); otherwise a non-git cwd containing
// repositories upgrades the old "not inside a git repository" error into
// workspace mode.
let workspace: WorkspaceContext | undefined
if (scanned.multi || !isGitRepo()) {
  const root = resolve(scanned.dir ?? process.cwd())
  const discovered = discoverWorkspace(root)
  if (discovered.repos.length === 0) {
    console.error(
      `Error: no git repositories found in ${root}` +
        (values.multi ? '' : ' (and the current directory is not a git repository)'),
    )
    process.exit(1)
  }
  if (values.repo?.length) {
    const unmatched = values.repo.filter((n) => !discovered.repos.some((rel) => rel === n || rel.endsWith('/' + n)))
    if (unmatched.length > 0) {
      console.error(`Error: --repo did not match any repository: ${unmatched.join(', ')}\nAvailable: ${discovered.repos.join(', ')}`)
      process.exit(1)
    }
  }
  workspace = {
    root,
    repos: discovered.repos,
    repoFilter: values.repo?.length ? values.repo : undefined,
  }
  console.error(`diffx: workspace mode — ${workspace.repos.length} repositories (discovered via ${discovered.source})`)
} else if (values.repo?.length) {
  console.error('Error: --repo is only valid in workspace mode (--multi, or a non-git directory containing repositories)')
  process.exit(1)
}

const port = await getPort(values.port ? { port: parseInt(values.port, 10) } : undefined)
const host = values.host ?? '0.0.0.0'

// 0.0.0.0 is a bind address, not a URL a browser can open — print and open
// the loopback address instead.
const displayHost = host === '0.0.0.0' ? '127.0.0.1' : host

const __dirname = dirname(fileURLToPath(import.meta.url))
const clientDir = resolve(__dirname, 'client')
const { existsSync } = await import('node:fs')
const resolvedClientDir = existsSync(clientDir)
  ? clientDir
  : resolve(process.cwd(), 'dist/client')

const { port: actualPort } = await startServer({ port, host, clientDir: resolvedClientDir, customDiffArgs, workspace })

const localUrl = `http://${displayHost}:${actualPort}`

console.log(`diffx server running at ${localUrl}`)

if (!values['no-open']) {
  const settings = loadSettings()
  const openUrl = `http://${displayHost}:${actualPort}`
  const openModule = await import('open')
  let appName: string | readonly string[] | undefined
  if (settings.browser) {
    const apps = openModule.apps as Record<string, string | readonly string[]>
    appName = apps[settings.browser] || settings.browser
  }
  const options = appName ? { app: { name: appName } } : {}
  openModule.default(openUrl, options)
}

process.on('SIGINT', () => {
  console.log('\nShutting down...')
  process.exit(0)
})
