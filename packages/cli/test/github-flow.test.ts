import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { runCli } from '../src/index'

const exec = promisify(execFile)

declare global {
  var __clifyGithubRun: { version: string; argv: string[] } | undefined
}

async function git(cwd: string, args: string[]) {
  await exec('git', args, { cwd })
}

async function writePluginRepo(repo: string, version: string, body = '') {
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

async function makeRemote(root: string) {
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

function harness(root: string) {
  let stdout = ''
  let stderr = ''
  return {
    options: {
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
      now: () => new Date('2026-05-11T10:00:00.000Z').getTime(),
    },
    get stdout() {
      return stdout
    },
    get stderr() {
      return stderr
    },
  }
}

async function state(root: string) {
  return JSON.parse(await readFile(join(root, 'state/clify/state.json'), 'utf8'))
}

describe('GitHub install and management flow', () => {
  it('installs on first run, records state, delegates argv, and lists metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clify-github-'))
    await makeRemote(root)
    const run = harness(root)

    await expect(runCli(['acme/demo', 'api', 'search', 'tea'], run.options)).resolves.toBe(0)

    expect(globalThis.__clifyGithubRun).toEqual({
      version: '0.1.0',
      argv: ['api', 'search', 'tea'],
    })
    expect(run.stderr).toContain('installing acme/demo from github.com/acme/demo@main')
    const saved = await state(root)
    expect(saved.plugins['acme/demo']).toMatchObject({
      id: 'acme/demo',
      owner: 'acme',
      repo: 'demo',
      ref: null,
      refKind: 'default-branch',
      resolvedRef: 'main',
      pluginVersion: '0.1.0',
      pluginDescription: 'Demo plugin.',
    })
    expect(saved.plugins['acme/demo'].sha).toMatch(/^[0-9a-f]{40}$/)

    const list = harness(root)
    await expect(runCli(['list', '--format', 'json'], list.options)).resolves.toBe(0)
    expect(JSON.parse(list.stdout)).toEqual([
      expect.objectContaining({ id: 'acme/demo', version: '0.1.0', ref: 'main' }),
    ])
  })

  it('updates branch installs, rolls back invalid explicit updates, and removes idempotently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clify-github-'))
    const repo = await makeRemote(root)

    await expect(runCli(['add', 'acme/demo'], harness(root).options)).resolves.toBe(0)
    const before = (await state(root)).plugins['acme/demo'].sha

    await writePluginRepo(repo, '0.2.0')
    await git(repo, ['add', '.'])
    await git(repo, ['commit', '-m', 'update plugin'])
    await expect(runCli(['update', 'acme/demo'], harness(root).options)).resolves.toBe(0)

    const afterGood = await state(root)
    expect(afterGood.plugins['acme/demo'].sha).not.toBe(before)
    expect(afterGood.plugins['acme/demo'].pluginVersion).toBe('0.2.0')

    await writePluginRepo(repo, '0.3.0', "throw new Error('bad release')\n")
    await git(repo, ['add', '.'])
    await git(repo, ['commit', '-m', 'bad plugin'])
    const badUpdate = harness(root)
    await expect(runCli(['update', 'acme/demo'], badUpdate.options)).resolves.toBe(1)
    expect(badUpdate.stderr).toContain('PLUGIN_LOAD_ERROR')
    expect((await state(root)).plugins['acme/demo'].sha).toBe(afterGood.plugins['acme/demo'].sha)

    const remove = harness(root)
    await expect(runCli(['remove', 'acme/demo'], remove.options)).resolves.toBe(0)
    expect(remove.stdout).toContain('removed: true')
    const removeAgain = harness(root)
    await expect(runCli(['rm', 'acme/demo'], removeAgain.options)).resolves.toBe(0)
    expect(removeAgain.stdout).toContain('removed: false')
  })

  it('keeps tag installs pinned during normal runs and supports info output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clify-github-'))
    const repo = await makeRemote(root)

    await expect(runCli(['acme/demo@v0.1.0'], harness(root).options)).resolves.toBe(0)
    await writePluginRepo(repo, '0.2.0')
    await git(repo, ['add', '.'])
    await git(repo, ['commit', '-m', 'branch update'])

    await expect(runCli(['acme/demo@v0.1.0'], harness(root).options)).resolves.toBe(0)

    expect(globalThis.__clifyGithubRun).toEqual({ version: '0.1.0', argv: [] })
    const info = harness(root)
    await expect(runCli(['info', 'acme/demo@v0.1.0'], info.options)).resolves.toBe(0)
    expect(info.stdout).toContain('plugin: acme/demo@v0.1.0')
    expect(info.stdout).toContain('llms:')
  })
})
