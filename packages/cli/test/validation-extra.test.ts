import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ClifyError } from '../src/errors'
import { validatePlugin } from '../src/plugin'

async function root() {
  return mkdtemp(join(tmpdir(), 'clify-validation-extra-'))
}

async function writePackage(dir: string, value: unknown) {
  await writeFile(join(dir, 'package.json'), JSON.stringify(value, null, 2))
}

async function writeEntry(dir: string, path = 'dist/index.js', source = validExport()) {
  await mkdir(join(dir, 'dist'), { recursive: true })
  await writeFile(join(dir, path), source)
}

function manifest(extra: Record<string, unknown> = {}) {
  return {
    name: 'demo',
    version: '0.1.0',
    type: 'module',
    repository: { url: 'https://github.com/acme/demo' },
    clify: { name: 'demo', description: 'Demo plugin.' },
    ...extra,
  }
}

function validExport() {
  return "export default { options: { name: 'demo' }, fetch() {}, serve() { return undefined } }\n"
}

async function expectInvalid(promise: Promise<unknown>) {
  await expect(promise).rejects.toThrow(ClifyError)
  await expect(promise).rejects.toMatchObject({ code: 'INVALID_PLUGIN' })
}

describe('plugin validation edge cases', () => {
  it('rejects missing, malformed, or non-object package files', async () => {
    const missing = await root()
    await expectInvalid(validatePlugin(missing))

    const malformed = await root()
    await writeFile(join(malformed, 'package.json'), '{')
    await expectInvalid(validatePlugin(malformed))

    const arrayPackage = await root()
    await writePackage(arrayPackage, [])
    await expectInvalid(validatePlugin(arrayPackage))

    const packageDirectory = await root()
    await mkdir(join(packageDirectory, 'package.json'))
    await expect(validatePlugin(packageDirectory)).rejects.toThrow()
  })

  it('rejects missing required manifest fields and invalid repository forms', async () => {
    const missingName = await root()
    await writePackage(missingName, manifest({ name: '' }))
    await expectInvalid(validatePlugin(missingName))

    const missingClify = await root()
    await writePackage(missingClify, {
      name: 'demo',
      version: '0.1.0',
      repository: 'github:acme/demo',
    })
    await expectInvalid(validatePlugin(missingClify))

    const invalidRepository = await root()
    await writePackage(invalidRepository, manifest({ repository: { url: '' } }))
    await expectInvalid(validatePlugin(invalidRepository))

    const invalidEntry = await root()
    await writePackage(
      invalidEntry,
      manifest({ clify: { name: 'demo', description: 'Demo', entry: 1 } }),
    )
    await expectInvalid(validatePlugin(invalidEntry))
  })

  it('loads mjs entries without type module and rejects missing or directory entries', async () => {
    const mjs = await root()
    await writePackage(
      mjs,
      manifest({
        type: undefined,
        clify: { name: 'demo', description: 'Demo', entry: './dist/index.mjs' },
      }),
    )
    await writeEntry(mjs, 'dist/index.mjs')
    await expect(validatePlugin(mjs)).resolves.toMatchObject({
      manifest: { entry: './dist/index.mjs' },
    })

    const missingEntry = await root()
    await writePackage(missingEntry, manifest())
    await expectInvalid(validatePlugin(missingEntry))

    const directoryEntry = await root()
    await writePackage(
      directoryEntry,
      manifest({ clify: { name: 'demo', description: 'Demo', entry: './dist' } }),
    )
    await mkdir(join(directoryEntry, 'dist'), { recursive: true })
    await expectInvalid(validatePlugin(directoryEntry))

    const notDirectory = await root()
    await writePackage(notDirectory, manifest())
    await writeFile(join(notDirectory, 'dist'), 'not a directory')
    await expect(validatePlugin(notDirectory)).rejects.toThrow()
    await rm(join(notDirectory, 'dist'), { force: true })
  })

  it('rejects missing default export and invalid cli shape', async () => {
    const noDefault = await root()
    await writePackage(noDefault, manifest())
    await writeEntry(noDefault, 'dist/index.js', 'export const cli = {}\n')
    await expectInvalid(validatePlugin(noDefault))

    const invalidShape = await root()
    await writePackage(invalidShape, manifest())
    await writeEntry(invalidShape, 'dist/index.js', 'export default { serve() {} }\n')
    await expectInvalid(validatePlugin(invalidShape))
  })

  it('handles string import throws and alternate cli name fields', async () => {
    const throwing = await root()
    await writePackage(throwing, manifest())
    await writeEntry(throwing, 'dist/index.js', "throw 'boom'\n")
    await expect(validatePlugin(throwing)).rejects.toMatchObject({ code: 'PLUGIN_LOAD_ERROR' })

    const privateName = await root()
    const warnings: string[] = []
    await writePackage(privateName, manifest())
    await writeEntry(
      privateName,
      'dist/index.js',
      "export default { _name: 'other', fetch() {}, serve() {} }\n",
    )
    await validatePlugin(privateName, {
      repoName: 'demo',
      warn: (message) => warnings.push(message),
    })
    expect(warnings.join('\n')).toContain("Cli='other'")

    const mismatchWithoutWarn = await root()
    await writePackage(mismatchWithoutWarn, manifest())
    await writeEntry(
      mismatchWithoutWarn,
      'dist/index.js',
      "export default { name: 'other', fetch() {}, serve() {} }\n",
    )
    await expect(validatePlugin(mismatchWithoutWarn, { repoName: 'demo' })).resolves.toMatchObject({
      manifest: { pluginName: 'demo' },
    })

    const unnamed = await root()
    await writePackage(unnamed, manifest())
    await writeEntry(unnamed, 'dist/index.js', 'export default { fetch() {}, serve() {} }\n')
    await expect(validatePlugin(unnamed, { repoName: 'demo' })).resolves.toMatchObject({
      manifest: { pluginName: 'demo' },
    })
  })
})
