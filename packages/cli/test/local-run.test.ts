import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCli } from '../src/index'

declare global {
  var __clifyLocalRun: { argv: string[] } | undefined
}

async function writeLocalPlugin(root: string) {
  await mkdir(join(root, 'dist'), { recursive: true })
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'local-demo',
      version: '0.1.0',
      type: 'module',
      repository: 'github:acme/local-demo',
      clify: { name: 'local-demo', description: 'Local demo.', entry: './dist/index.js' },
    }),
  )
  await writeFile(
    join(root, 'dist/index.js'),
    "export default { name: 'local-demo', fetch() {}, async serve(argv) { globalThis.__clifyLocalRun = { argv }; return 7 } }\n",
  )
}

function harness(cwd: string) {
  let stdout = ''
  let stderr = ''
  return {
    options: {
      cwd,
      env: {
        ...process.env,
        HOME: cwd,
        XDG_CACHE_HOME: join(cwd, 'cache'),
        XDG_STATE_HOME: join(cwd, 'state'),
      },
      stdout: (chunk: string) => {
        stdout += chunk
      },
      stderr: (chunk: string) => {
        stderr += chunk
      },
    },
    get stdout() {
      return stdout
    },
    get stderr() {
      return stderr
    },
  }
}

describe('local plugin runs', () => {
  it('loads a local plugin, forwards argv unchanged, and does not write state', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'clify-local-'))
    const plugin = join(cwd, 'plugin')
    await writeLocalPlugin(plugin)
    const io = harness(cwd)

    await expect(runCli(['./plugin', 'api', 'search', '--silent'], io.options)).resolves.toBe(7)

    expect(globalThis.__clifyLocalRun).toEqual({ argv: ['api', 'search', '--silent'] })
    await expect(access(join(cwd, 'state/clify/state.json'))).rejects.toThrow()
    expect(io.stderr).toBe('')
    expect(io.stdout).toBe('')
  })

  it('treats an undefined plugin serve result as success', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'clify-local-'))
    const plugin = join(cwd, 'plugin')
    await writeLocalPlugin(plugin)
    await writeFile(
      join(plugin, 'dist/index.js'),
      "export default { name: 'local-demo', fetch() {}, async serve(argv) { globalThis.__clifyLocalRun = { argv } } }\n",
    )
    const io = harness(cwd)

    await expect(runCli(['./plugin'], io.options)).resolves.toBe(0)

    expect(globalThis.__clifyLocalRun).toEqual({ argv: [] })
  })

  it('forwards local plugin validation warnings', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'clify-local-'))
    const plugin = join(cwd, 'plugin')
    await writeLocalPlugin(plugin)
    await writeFile(
      join(plugin, 'dist/index.js'),
      "export default { name: 'other', fetch() {}, async serve() { return 0 } }\n",
    )
    const io = harness(cwd)

    await expect(runCli(['./plugin'], io.options)).resolves.toBe(0)

    expect(io.stderr).toContain('plugin name mismatch')
  })

  it('rejects local paths for management commands and cache-only flags', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'clify-local-'))
    const plugin = join(cwd, 'plugin')
    await writeLocalPlugin(plugin)
    const add = harness(cwd)
    const reinstall = harness(cwd)

    await expect(runCli(['add', './plugin'], add.options)).resolves.toBe(1)
    await expect(runCli(['remove', './plugin'], add.options)).resolves.toBe(1)
    await expect(runCli(['--reinstall', './plugin'], reinstall.options)).resolves.toBe(1)

    expect(add.stderr).toContain('LOCAL_NOT_MANAGED')
    expect(reinstall.stderr).toContain('LOCAL_NOT_MANAGED')
  })
})
