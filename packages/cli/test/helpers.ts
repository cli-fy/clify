import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { RunCliOptions } from '../src/index'

const exec = promisify(execFile)

export async function git(cwd: string, args: string[]) {
  await exec('git', args, { cwd })
}

export async function writePluginRepo(repo: string, version: string, body = '') {
  await mkdir(join(repo, 'dist'), { recursive: true })
  await writeFile(
    join(repo, 'package.json'),
    JSON.stringify(
      {
        name: 'demo',
        version,
        type: 'module',
        repository: 'github:acme/demo',
        clify: { name: 'demo', description: 'Demo plugin.', entry: './dist/index.js' },
      },
      null,
      2,
    ),
  )
  await writeFile(
    join(repo, 'dist/index.js'),
    body ||
      `export default { name: 'demo', fetch() {}, async serve(argv) { globalThis.__clifyGithubRun = { version: '${version}', argv }; return 0 } }\n`,
  )
}

export async function makeRemote(root: string) {
  const repo = join(root, 'remotes/acme/demo')
  await mkdir(repo, { recursive: true })
  await git(repo, ['init', '--initial-branch', 'main'])
  await git(repo, ['config', 'user.email', 'test@example.com'])
  await git(repo, ['config', 'user.name', 'Test User'])
  await writePluginRepo(repo, '0.1.0')
  await git(repo, ['add', '.'])
  await git(repo, ['commit', '-m', 'initial plugin'])
  await git(repo, ['tag', 'v0.1.0'])
  await writeFile(
    join(root, 'gitconfig'),
    `[url "file://${join(root, 'remotes')}/"]\n\tinsteadOf = https://github.com/\n`,
  )
  return repo
}

export function harness(root: string, options: { now?: () => number } = {}) {
  let stdout = ''
  let stderr = ''
  const runOptions: RunCliOptions = {
    cwd: root,
    env: {
      ...process.env,
      HOME: root,
      GIT_CONFIG_GLOBAL: join(root, 'gitconfig'),
      XDG_CACHE_HOME: join(root, 'cache'),
      XDG_STATE_HOME: join(root, 'state'),
    },
    stdout: (chunk: string) => {
      stdout += chunk
    },
    stderr: (chunk: string) => {
      stderr += chunk
    },
    now: options.now ?? (() => new Date('2026-05-11T10:00:00.000Z').getTime()),
  }
  return {
    options: runOptions,
    get stdout() {
      return stdout
    },
    get stderr() {
      return stderr
    },
  }
}

export async function state(root: string) {
  return JSON.parse(await readFile(join(root, 'state/clify/state.json'), 'utf8'))
}
