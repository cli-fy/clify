import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ClifyError } from '../src/errors'
import { validatePlugin } from '../src/plugin'

async function pluginRoot() {
  return mkdtemp(join(tmpdir(), 'clify-plugin-'))
}

async function writePlugin(
  root: string,
  options: {
    packageJson?: Record<string, unknown>
    entry?: string
    entryPath?: string
  } = {},
) {
  const entryPath = options.entryPath ?? './dist/index.js'
  await mkdir(join(root, 'dist'), { recursive: true })
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify(
      options.packageJson ?? {
        name: 'demo',
        version: '0.1.0',
        type: 'module',
        repository: 'github:acme/demo',
        clify: {
          name: 'demo',
          description: 'Demo plugin.',
          entry: entryPath,
        },
      },
      null,
      2,
    ),
  )
  await writeFile(
    join(root, entryPath.replace(/^\.\//, '')),
    options.entry ??
      "export default { name: 'demo', fetch() {}, async serve(argv) { globalThis.__clifyValidationArgv = argv; return 0 } }\n",
  )
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toThrow(ClifyError)
  try {
    await promise
  } catch (error) {
    expect(error).toMatchObject({ code })
  }
}

describe('plugin validation', () => {
  it('loads a valid ESM plugin and returns manifest metadata', async () => {
    const root = await pluginRoot()
    await writePlugin(root)

    const result = await validatePlugin(root, { repoName: 'demo' })

    expect(result.manifest).toMatchObject({
      packageName: 'demo',
      version: '0.1.0',
      repository: 'github:acme/demo',
      pluginName: 'demo',
      description: 'Demo plugin.',
      entry: './dist/index.js',
    })
    expect(typeof result.cli.serve).toBe('function')
    expect(typeof result.cli.fetch).toBe('function')
  })

  it('rejects invalid manifests with INVALID_PLUGIN', async () => {
    const root = await pluginRoot()
    await writePlugin(root, {
      packageJson: {
        name: 'demo',
        version: 'not-semver',
        type: 'module',
        repository: 'github:acme/demo',
        clify: { name: 'demo', description: 'Demo plugin.' },
      },
    })

    await expectCode(validatePlugin(root, { repoName: 'demo' }), 'INVALID_PLUGIN')
  })

  it('requires type module for .js entries', async () => {
    const root = await pluginRoot()
    await writePlugin(root, {
      packageJson: {
        name: 'demo',
        version: '0.1.0',
        repository: 'github:acme/demo',
        clify: { name: 'demo', description: 'Demo plugin.' },
      },
    })

    await expectCode(validatePlugin(root, { repoName: 'demo' }), 'INVALID_PLUGIN')
  })

  it('rejects entries outside the plugin root', async () => {
    const root = await pluginRoot()
    await mkdir(join(root, 'dist'), { recursive: true })
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'demo',
        version: '0.1.0',
        type: 'module',
        repository: 'github:acme/demo',
        clify: { name: 'demo', description: 'Demo plugin.', entry: '../outside.js' },
      }),
    )

    await expectCode(validatePlugin(root, { repoName: 'demo' }), 'INVALID_PLUGIN')
  })

  it('reports top-level import failures as PLUGIN_LOAD_ERROR', async () => {
    const root = await pluginRoot()
    await writePlugin(root, { entry: "throw new Error('boom')\nexport default {}\n" })

    await expectCode(validatePlugin(root, { repoName: 'demo' }), 'PLUGIN_LOAD_ERROR')
  })

  it('warns but proceeds on plugin name mismatch', async () => {
    const root = await pluginRoot()
    const warnings: string[] = []
    await writePlugin(root, {
      entry: "export default { name: 'cli-demo', fetch() {}, async serve() { return 0 } }\n",
    })

    await validatePlugin(root, { repoName: 'demo', warn: (message) => warnings.push(message) })

    expect(warnings.join('\n')).toContain('plugin name mismatch')
    expect(warnings.join('\n')).toContain("Cli='cli-demo'")
  })
})
