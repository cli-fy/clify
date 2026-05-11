import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCli } from '../src/index'

function harness(root: string) {
  let stdout = ''
  let stderr = ''
  return {
    options: {
      cwd: root,
      env: {
        ...process.env,
        HOME: root,
        XDG_CACHE_HOME: join(root, 'cache'),
        XDG_STATE_HOME: join(root, 'state'),
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

describe('errors and top-level routing', () => {
  it('returns UNKNOWN_COMMAND for non-source, non-reserved tokens', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clify-errors-'))
    const io = harness(root)

    await expect(runCli(['bogus'], io.options)).resolves.toBe(1)

    expect(io.stderr).toContain('UNKNOWN_COMMAND')
  })

  it('writes structured errors to stdout in json mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clify-errors-'))
    const io = harness(root)

    await expect(runCli(['--format', 'json', 'bogus'], io.options)).resolves.toBe(1)

    expect(io.stderr).toBe('')
    expect(JSON.parse(io.stdout)).toMatchObject({ ok: false, error: { code: 'UNKNOWN_COMMAND' } })
  })

  it('prints help and version without installing anything', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clify-errors-'))
    const help = harness(root)
    const version = harness(root)

    await expect(runCli(['--help'], help.options)).resolves.toBe(0)
    await expect(runCli(['--version'], version.options)).resolves.toBe(0)

    expect(help.stdout).toContain('Usage: clify <source-spec>')
    expect(version.stdout).toMatch(/0\.1\.0/)
  })
})
