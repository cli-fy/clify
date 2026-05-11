import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCli } from '../src/index'

function harness(cwd: string) {
  let stdout = ''
  let stderr = ''
  return {
    options: {
      cwd,
      env: { ...process.env, HOME: cwd },
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

describe('clify init', () => {
  it('scaffolds the plugin template without ignoring dist', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'clify-init-'))
    const dir = join(cwd, 'my-plugin')
    const io = harness(cwd)

    await expect(runCli(['init', 'my-plugin'], io.options)).resolves.toBe(0)

    await expect(readdir(dir)).resolves.toEqual(
      expect.arrayContaining([
        '.gitignore',
        'LICENSE',
        'README.md',
        'package.json',
        'src',
        'tsconfig.json',
        'tsdown.config.ts',
      ]),
    )
    const gitignore = await readFile(join(dir, '.gitignore'), 'utf8')
    expect(gitignore).toContain('Do NOT ignore dist')
    expect(gitignore).not.toMatch(/^dist\//m)
    const packageJson = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
    expect(packageJson).toMatchObject({
      name: 'my-plugin',
      type: 'module',
      clify: { name: 'my-plugin', entry: './dist/index.js' },
      scripts: { build: 'tsdown', dev: 'tsdown --watch', prepack: 'tsdown' },
    })
    expect(io.stdout).toContain('created:')
    expect(io.stderr).toBe('')
  })

  it('refuses non-empty directories unless only .git exists with --force', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'clify-init-'))
    const dir = join(cwd, 'existing')
    await mkdir(dir)
    await writeFile(join(dir, 'README.md'), 'mine')
    const io = harness(cwd)

    await expect(runCli(['init', 'existing'], io.options)).resolves.toBe(1)

    expect(io.stderr).toContain('DIR_NOT_EMPTY')
  })

  it('refuses a target that is not a directory', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'clify-init-'))
    await writeFile(join(cwd, 'file'), 'not a directory')
    const io = harness(cwd)

    await expect(runCli(['init', 'file'], io.options)).resolves.toBe(1)

    expect(io.stderr).toContain('DIR_NOT_EMPTY')
  })

  it('allows --force when a greenfield directory only contains .git', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'clify-init-'))
    const dir = join(cwd, 'existing')
    await mkdir(join(dir, '.git'), { recursive: true })
    const io = harness(cwd)

    await expect(runCli(['init', '--force', 'existing'], io.options)).resolves.toBe(0)

    await expect(readFile(join(dir, 'src/index.ts'), 'utf8')).resolves.toContain(
      "Cli.create('existing'",
    )
  })
})
