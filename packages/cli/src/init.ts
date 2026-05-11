import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ClifyError, nodeErrorCode } from './errors.js'

interface InitOptions {
  readonly cwd: string
  readonly force?: boolean
}

const templateFiles = [
  '_gitignore',
  'LICENSE',
  'README.md',
  'package.json',
  'tsconfig.json',
  'tsdown.config.ts',
  'src/index.ts',
] as const

export async function initPlugin(
  targetArg: string | undefined,
  options: InitOptions,
): Promise<string> {
  const target = resolve(options.cwd, targetArg ?? '.')
  const pluginName = basename(target)
  await assertCanWriteTarget(target, options.force === true)
  const templateDir = await findTemplateDir()
  for (const file of templateFiles) {
    const outputFile = file === '_gitignore' ? '.gitignore' : file
    const input = join(templateDir, file)
    const output = join(target, outputFile)
    const raw = await readFile(input, 'utf8')
    await mkdir(dirname(output), { recursive: true })
    await writeFile(output, raw.replaceAll('my-plugin', pluginName), { flag: 'wx' })
  }
  return target
}

async function assertCanWriteTarget(target: string, force: boolean): Promise<void> {
  try {
    const targetStat = await stat(target)
    if (!targetStat.isDirectory())
      throw new ClifyError('DIR_NOT_EMPTY', `${target} is not a directory`)
  } catch (error) {
    if (nodeErrorCode(error) === 'ENOENT') {
      await mkdir(target, { recursive: true })
      return
    }
    throw error
  }

  const entries = await readdir(target)
  if (entries.length === 0) return
  if (force && entries.length === 1 && entries[0] === '.git') return
  throw new ClifyError('DIR_NOT_EMPTY', `${target} is not empty`)
}

async function findTemplateDir(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [resolve(here, '../../template'), resolve(here, '../template')]
  for (const candidate of candidates) {
    try {
      const candidateStat = await stat(candidate)
      if (candidateStat.isDirectory()) return candidate
    } catch (error) {
      /* v8 ignore next */
      if (nodeErrorCode(error) !== 'ENOENT') throw error
    }
  }
  /* v8 ignore next */
  throw new ClifyError('INSTALL_FAILED', 'template files are missing from the package')
}
