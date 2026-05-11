import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { diskBytes } from '../src/cache'
import { ClifyError, errorMessage, nodeErrorCode } from '../src/errors'
import { currentBranch } from '../src/git'
import { runCli } from '../src/index'
import { withFileLock } from '../src/locks'
import { getXdgPaths } from '../src/paths'
import { readState, removeCacheDir, touchLastUsed, writeState } from '../src/state'
import { git, harness, makeRemote, state, writePluginRepo } from './helpers'

declare global {
  var __clifyGithubRun: { version: string; argv: string[] } | undefined
}

describe('spec edge behavior', () => {
  it('supports schema, llms, json aliases, filtering, full output, and unknown fatal stderr', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clify-edges-'))
    await makeRemote(root)
    await expect(runCli(['add', 'acme/demo'], harness(root).options)).resolves.toBe(0)

    const schema = harness(root)
    await expect(runCli(['--schema'], schema.options)).resolves.toBe(0)
    expect(JSON.parse(schema.stdout)).toMatchObject({ name: 'clify' })

    const llms = harness(root)
    await expect(runCli(['--llms'], llms.options)).resolves.toBe(0)
    expect(llms.stdout).toContain('resolve, install, validate')

    const filtered = harness(root)
    await expect(
      runCli(['list', '--json', '--filter-output', 'id,version'], filtered.options),
    ).resolves.toBe(0)
    expect(JSON.parse(filtered.stdout)).toEqual([{ id: 'acme/demo', version: '0.1.0' }])

    const objectFilter = harness(root)
    await expect(
      runCli(
        ['add', 'acme/demo', '--format', 'json', '--filter-output', 'installed'],
        objectFilter.options,
      ),
    ).resolves.toBe(0)
    expect(JSON.parse(objectFilter.stdout)).toEqual({ installed: 'acme/demo' })

    const blankFilter = harness(root)
    await expect(runCli(['list', '--filter-output', '   '], blankFilter.options)).resolves.toBe(0)
    expect(blankFilter.stdout).toContain('acme/demo')

    const full = harness(root)
    await expect(runCli(['ls', '--full-output', '--format', 'json'], full.options)).resolves.toBe(0)
    expect(JSON.parse(full.stdout)[0]).toMatchObject({ diskBytes: expect.any(Number) })

    const textList = harness(root)
    await expect(runCli(['list'], textList.options)).resolves.toBe(0)
    expect(textList.stdout).toContain('acme/demo')

    const fatal = harness(root)
    await expect(runCli(['--silent', 'bogus'], fatal.options)).resolves.toBe(1)
    expect(fatal.stderr).toContain('UNKNOWN_COMMAND')

    const empty = harness(await mkdtemp(join(tmpdir(), 'clify-empty-list-')))
    await expect(runCli(['list'], empty.options)).resolves.toBe(0)
    expect(empty.stdout).toBe('plugins[0]:\n')
  })

  it('routes top-level globals, required-arg failures, and unexpected renderer errors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clify-routing-'))
    const help = harness(root)
    await expect(
      runCli(['--token-limit', '10', '--token-offset', '0', '--token-count', 'help'], help.options),
    ).resolves.toBe(0)
    expect(help.stdout).toContain('Usage: clify')

    const shortHelp = harness(root)
    await expect(runCli(['-h'], shortHelp.options)).resolves.toBe(0)
    expect(shortHelp.stdout).toContain('Usage: clify')

    const shortVersion = harness(root)
    await expect(runCli(['-v'], shortVersion.options)).resolves.toBe(0)
    expect(shortVersion.stdout).toContain('0.1.0')

    const textFormat = harness(root)
    await expect(runCli(['--format', 'toon', '--help'], textFormat.options)).resolves.toBe(0)
    expect(textFormat.stdout).toContain('Usage: clify')

    for (const argv of [
      ['add'],
      ['remove'],
      ['info'],
      ['info', './local'],
      ['update', './local'],
      ['--format'],
      ['--filter-output'],
      ['--token-limit'],
    ]) {
      const io = harness(root)
      await expect(runCli(argv, io.options)).resolves.toBe(1)
      expect(io.stderr).toMatch(/INVALID_SOURCE_SPEC|LOCAL_NOT_MANAGED|UNKNOWN_COMMAND/)
    }

    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      await expect(runCli(['--version'])).resolves.toBe(0)
      expect(write).toHaveBeenCalled()
    } finally {
      write.mockRestore()
    }

    let stderr = ''
    await expect(
      runCli(['--version'], {
        ...harness(root).options,
        stdout: () => {
          throw new Error('stdout broke')
        },
        stderr: (chunk) => {
          stderr += chunk
        },
      }),
    ).resolves.toBe(1)
    expect(stderr).toContain('INSTALL_FAILED')

    stderr = ''
    await expect(
      runCli(['--version'], {
        ...harness(root).options,
        stdout: () => {
          throw { not: 'an error' }
        },
        stderr: (chunk) => {
          stderr += chunk
        },
      }),
    ).resolves.toBe(1)
    expect(stderr).toContain('unknown error')
  })

  it('normalizes explicit update ids and reports unknown installed plugins', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clify-edges-'))
    const repo = await makeRemote(root)
    await expect(runCli(['add', 'acme/demo'], harness(root).options)).resolves.toBe(0)
    await expect(runCli(['add', 'acme/demo'], harness(root).options)).resolves.toBe(0)
    await writePluginRepo(repo, '0.2.0')
    await git(repo, ['add', '.'])
    await git(repo, ['commit', '-m', 'case update'])

    await expect(runCli(['update', 'Acme/Demo'], harness(root).options)).resolves.toBe(0)
    expect((await state(root)).plugins['acme/demo'].pluginVersion).toBe('0.2.0')

    const missing = harness(root)
    await expect(runCli(['update', 'acme/missing'], missing.options)).resolves.toBe(1)
    expect(missing.stderr).toContain('PLUGIN_NOT_INSTALLED')
  })

  it('handles explicit branch, sha, ref-not-found, and failed ref lookup paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clify-edges-'))
    const repo = await makeRemote(root)
    const sha = (await stateAfterAdd(root, 'acme/demo')).plugins['acme/demo'].sha as string

    await expect(runCli(['add', 'acme/demo@main'], harness(root).options)).resolves.toBe(0)
    await expect(runCli([`add`, `acme/demo@${sha}`], harness(root).options)).resolves.toBe(0)
    await git(repo, ['tag', '-a', 'v0.1.1', '-m', 'annotated release'])
    await expect(runCli(['add', 'acme/demo@v0.1.1'], harness(root).options)).resolves.toBe(0)
    const saved = await state(root)
    expect(saved.plugins['acme/demo@main']).toMatchObject({ refKind: 'branch' })
    expect(saved.plugins[`acme/demo@${sha}`]).toMatchObject({ refKind: 'sha' })
    expect(saved.plugins['acme/demo@v0.1.1']).toMatchObject({ refKind: 'tag' })

    const missingRef = harness(root)
    await expect(runCli(['add', 'acme/demo@missing'], missingRef.options)).resolves.toBe(1)
    expect(missingRef.stderr).toContain('REF_NOT_FOUND')

    await rm(repo, { recursive: true, force: true })
    const failedLookup = harness(root)
    await expect(runCli(['add', 'acme/demo@other'], failedLookup.options)).resolves.toBe(1)
    expect(failedLookup.stderr).toContain('INSTALL_FAILED')
  })

  it('refreshes stale branch installs, respects --no-fetch, and falls back on TTL failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clify-edges-'))
    const repo = await makeRemote(root)
    await expect(runCli(['acme/demo'], harness(root).options)).resolves.toBe(0)

    await writePluginRepo(repo, '0.2.0')
    await git(repo, ['add', '.'])
    await git(repo, ['commit', '-m', 'fresh branch'])
    await makeStateStale(root, 'acme/demo')

    await expect(runCli(['--no-fetch', 'acme/demo'], harness(root).options)).resolves.toBe(0)
    expect(globalThis.__clifyGithubRun).toEqual({ version: '0.1.0', argv: [] })

    await expect(runCli(['acme/demo'], harness(root).options)).resolves.toBe(0)
    expect(globalThis.__clifyGithubRun).toEqual({ version: '0.2.0', argv: [] })

    await makeStateStale(root, 'acme/demo')
    await rm(repo, { recursive: true, force: true })
    const offline = harness(root)
    await expect(runCli(['acme/demo'], offline.options)).resolves.toBe(0)
    expect(offline.stderr).toContain('could not refresh acme/demo')
    expect(globalThis.__clifyGithubRun).toEqual({ version: '0.2.0', argv: [] })
  })

  it('rolls back invalid TTL updates and fails explicit fetch updates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clify-ttl-invalid-'))
    const repo = await makeRemote(root)
    await expect(runCli(['acme/demo'], harness(root).options)).resolves.toBe(0)

    await writePluginRepo(repo, '0.2.0', "throw new Error('bad ttl')\n")
    await git(repo, ['add', '.'])
    await git(repo, ['commit', '-m', 'bad ttl'])
    await makeStateStale(root, 'acme/demo')
    const ttl = harness(root)
    await expect(runCli(['acme/demo'], ttl.options)).resolves.toBe(0)
    expect(ttl.stderr).toContain('PLUGIN_LOAD_ERROR')
    expect(globalThis.__clifyGithubRun).toEqual({ version: '0.1.0', argv: [] })

    await rm(repo, { recursive: true, force: true })
    const update = harness(root)
    await expect(runCli(['update', 'acme/demo'], update.options)).resolves.toBe(1)
    expect(update.stderr).toContain('INSTALL_FAILED')
  })

  it('updates all refs, skips sha refs, reinstalls, installs on info, and handles disk errors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clify-edges-'))
    await makeRemote(root)
    const sha = (await stateAfterAdd(root, 'acme/demo')).plugins['acme/demo'].sha as string
    await expect(runCli(['add', `acme/demo@${sha}`], harness(root).options)).resolves.toBe(0)
    await expect(runCli(['add', 'acme/demo@v0.1.0'], harness(root).options)).resolves.toBe(0)

    const updateAll = harness(root)
    await expect(runCli(['update'], updateAll.options)).resolves.toBe(0)
    expect(updateAll.stdout).toContain('(unchanged)')

    const reinstall = harness(root)
    await expect(runCli(['--reinstall', 'acme/demo'], reinstall.options)).resolves.toBe(0)

    const addReinstallRoot = await mkdtemp(join(tmpdir(), 'clify-add-reinstall-'))
    await makeRemote(addReinstallRoot)
    await expect(
      runCli(['add', '--reinstall', 'acme/demo'], harness(addReinstallRoot).options),
    ).resolves.toBe(0)

    const infoRoot = await mkdtemp(join(tmpdir(), 'clify-info-install-'))
    await makeRemote(infoRoot)
    const info = harness(infoRoot)
    await expect(runCli(['info', 'acme/demo'], info.options)).resolves.toBe(0)
    expect(info.stdout).toContain('plugin: acme/demo')

    await expect(removeCacheDir(join(root, 'missing'))).resolves.toBeUndefined()
    await expect(diskBytes(join(root, 'missing'))).resolves.toBe(0)
  })

  it('handles concurrent installs for the same id without duplicate state writes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clify-concurrent-install-'))
    await makeRemote(root)

    await expect(
      Promise.all([
        runCli(['add', 'acme/demo'], harness(root).options),
        runCli(['add', 'acme/demo'], harness(root).options),
      ]),
    ).resolves.toEqual([0, 0])

    expect(Object.keys((await state(root)).plugins)).toEqual(['acme/demo'])
  })

  it('removes invalid install candidates and reports missing git binaries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clify-invalid-install-'))
    const repo = await makeRemote(root)
    await writePluginRepo(repo, '0.2.0', 'export default {}\n')
    await git(repo, ['add', '.'])
    await git(repo, ['commit', '-m', 'invalid initial'])

    const invalid = harness(root)
    await expect(runCli(['add', 'acme/demo'], invalid.options)).resolves.toBe(1)
    expect(invalid.stderr).toContain('INVALID_PLUGIN')

    const missingGitRoot = await mkdtemp(join(tmpdir(), 'clify-missing-git-'))
    const missingGit = harness(missingGitRoot)
    await expect(
      runCli(['add', 'acme/demo'], {
        ...missingGit.options,
        env: { ...missingGit.options.env, PATH: '/path/that/does/not/exist' },
      }),
    ).resolves.toBe(1)
    expect(missingGit.stderr).toContain('INSTALL_FAILED')
  })

  it('forwards plugin validation warnings during install and cached loads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clify-warning-forwarding-'))
    const repo = await makeRemote(root)
    await writePluginRepo(
      repo,
      '0.2.0',
      "export default { name: 'other', fetch() {}, async serve() { return 0 } }\n",
    )
    await git(repo, ['add', '.'])
    await git(repo, ['commit', '-m', 'warn on name mismatch'])

    const install = harness(root)
    await expect(runCli(['add', 'acme/demo'], install.options)).resolves.toBe(0)
    expect(install.stderr).toContain('plugin name mismatch')

    const cached = harness(root)
    await expect(runCli(['acme/demo'], cached.options)).resolves.toBe(0)
    expect(cached.stderr).toContain('plugin name mismatch')
  })

  it('resolves current branch fallback for detached checkouts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clify-detached-'))
    const repo = await makeRemote(root)
    const sha = (await execGit(repo, ['rev-parse', 'HEAD'])).trim()
    await git(repo, ['checkout', sha])
    await expect(currentBranch(repo, process.env)).resolves.toBe('HEAD')
  })

  it('serializes locks and times out when a lock is held', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clify-locks-'))
    const lockPath = join(root, 'locks/test.lock')
    await expect(withFileLock(lockPath, async () => 'ok')).resolves.toBe('ok')

    await mkdir(join(root, 'locks'), { recursive: true })
    await writeFile(lockPath, 'held')
    const waits: number[] = []
    await expect(
      withFileLock(lockPath, async () => 'never', {
        timeoutMs: 0,
        onWait: (elapsed) => waits.push(elapsed),
      }),
    ).rejects.toMatchObject({ code: 'INSTALL_TIMEOUT' })
    expect(waits.length).toBe(1)

    await writeFile(lockPath, 'held')
    await expect(
      withFileLock(lockPath, async () => 'never', { timeoutMs: 1 }),
    ).rejects.toMatchObject({
      code: 'INSTALL_TIMEOUT',
    })
  })

  it('validates state shape and writes atomically under the state lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clify-state-'))
    const paths = getXdgPaths({ HOME: root, XDG_STATE_HOME: join(root, 'state') })

    await expect(readState(paths)).resolves.toEqual({ version: 1, plugins: {} })
    await mkdir(paths.stateRoot, { recursive: true })
    await writeFile(paths.stateFile, '{')
    await expect(readState(paths)).rejects.toThrow(ClifyError)

    await writeFile(paths.stateFile, JSON.stringify({ version: 2, plugins: {} }))
    await expect(readState(paths)).rejects.toThrow(ClifyError)

    await writeFile(paths.stateFile, JSON.stringify({ version: 1, plugins: { bad: 1 } }))
    await expect(readState(paths)).rejects.toThrow(ClifyError)

    await writeState(paths, { version: 1, plugins: {} })
    await expect(
      touchLastUsed(paths, 'missing', '2026-05-11T10:00:00.000Z'),
    ).resolves.toBeUndefined()
    await expect(readFile(paths.stateFile, 'utf8')).resolves.toContain('"version": 1')

    await rm(paths.stateFile, { force: true })
    await mkdir(paths.stateFile)
    await expect(readState(paths)).rejects.toThrow()
  })

  it('covers XDG defaults and error utility branches through public helpers', async () => {
    expect(getXdgPaths({}).cacheRoot).toContain('/.cache/clify')
    expect(getXdgPaths({ HOME: '/home/test' })).toMatchObject({
      cacheRoot: '/home/test/.cache/clify',
      stateRoot: '/home/test/.local/state/clify',
    })
    expect(errorMessage({})).toBe('unknown error')
    expect(nodeErrorCode('not an object')).toBeNull()
    expect(nodeErrorCode({ code: 123 })).toBeNull()
  })
})

async function execGit(cwd: string, args: string[]) {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const exec = promisify(execFile)
  const { stdout } = await exec('git', args, { cwd })
  return stdout
}

async function stateAfterAdd(root: string, id: string) {
  await expect(runCli(['add', id], harness(root).options)).resolves.toBe(0)
  return state(root)
}

async function makeStateStale(root: string, id: string) {
  const saved = await state(root)
  saved.plugins[id].lastFetchAt = '2026-05-09T10:00:00.000Z'
  await writeFile(join(root, 'state/clify/state.json'), `${JSON.stringify(saved, null, 2)}\n`)
}
