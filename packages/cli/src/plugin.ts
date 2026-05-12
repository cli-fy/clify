import { randomUUID } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { extname, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ClifyError, errorMessage, isRecord, nodeErrorCode } from './errors.js'

export interface PluginCli {
  readonly serve: (argv?: readonly string[]) => Promise<number | undefined> | number | undefined
  readonly fetch: (...args: readonly unknown[]) => unknown
}

interface PluginManifest {
  readonly packageName: string
  readonly version: string
  readonly repository: string
  readonly pluginName: string
  readonly description: string
  readonly entry: string
}

interface ValidatedPlugin {
  readonly manifest: PluginManifest
  readonly cli: PluginCli
  readonly entryPath: string
}

interface ValidatePluginOptions {
  readonly repoName?: string
  readonly warn?: (message: string) => void
}

const semverPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

export async function validatePlugin(
  root: string,
  options: ValidatePluginOptions = {},
): Promise<ValidatedPlugin> {
  const { manifest, entryPath } = await readManifest(root)
  const imported = await importEntry(entryPath)
  if (!isRecord(imported) || !('default' in imported)) {
    throw new ClifyError('INVALID_PLUGIN', 'plugin entry must default-export an incur Cli')
  }
  const exported = imported.default
  if (!isPluginCli(exported)) {
    throw new ClifyError(
      'INVALID_PLUGIN',
      'default export must have callable serve and fetch methods',
    )
  }
  warnOnNameMismatch(exported, manifest, options)
  return { manifest, cli: exported, entryPath }
}

async function readManifest(
  root: string,
): Promise<{ manifest: PluginManifest; entryPath: string }> {
  const packagePath = resolve(root, 'package.json')
  let raw: string
  try {
    raw = await readFile(packagePath, 'utf8')
  } catch (error) {
    if (nodeErrorCode(error) === 'ENOENT') {
      throw new ClifyError('INVALID_PLUGIN', 'package.json is required')
    }
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new ClifyError('INVALID_PLUGIN', 'package.json must be valid JSON', { cause: error })
  }
  if (!isRecord(parsed)) throw new ClifyError('INVALID_PLUGIN', 'package.json must be an object')
  const packageName = stringField(parsed, 'name')
  const version = stringField(parsed, 'version')
  if (!semverPattern.test(version))
    throw new ClifyError('INVALID_PLUGIN', 'package.json#version must be semver')
  const repository = repositoryField(parsed.repository)
  if (!isRecord(parsed.clify))
    throw new ClifyError('INVALID_PLUGIN', 'package.json#clify must be an object')
  const pluginName = stringField(parsed.clify, 'name', 'clify.name')
  const description = stringField(parsed.clify, 'description', 'clify.description')
  const entry = parsed.clify.entry === undefined ? './dist/index.js' : parsed.clify.entry
  if (typeof entry !== 'string')
    throw new ClifyError('INVALID_PLUGIN', 'clify.entry must be a string')
  if (extname(entry) === '.js' && parsed.type !== 'module') {
    throw new ClifyError('INVALID_PLUGIN', 'package.json#type must be "module" for .js entries')
  }
  const entryPath = resolve(root, entry)
  if (!isInside(root, entryPath))
    throw new ClifyError('INVALID_PLUGIN', 'clify.entry must stay inside the repo')
  try {
    const entryStat = await stat(entryPath)
    if (!entryStat.isFile()) throw new ClifyError('INVALID_PLUGIN', 'clify.entry must be a file')
  } catch (error) {
    if (error instanceof ClifyError) throw error
    if (nodeErrorCode(error) === 'ENOENT')
      throw new ClifyError('INVALID_PLUGIN', 'clify.entry does not exist')
    throw error
  }
  return {
    manifest: { packageName, version, repository, pluginName, description, entry },
    entryPath,
  }
}

async function importEntry(entryPath: string): Promise<unknown> {
  const url = pathToFileURL(entryPath)
  url.searchParams.set('clify-cache-bust', randomUUID())
  try {
    return await import(url.href)
  } catch (error) {
    if (error instanceof Error) {
      throw new ClifyError(
        'PLUGIN_LOAD_ERROR',
        `could not load plugin entry: ${errorMessage(error)}`,
        {
          cause: error,
        },
      )
    }
    throw new ClifyError('PLUGIN_LOAD_ERROR', `could not load plugin entry: ${errorMessage(error)}`)
  }
}

function stringField(record: Record<string, unknown>, key: string, label = key): string {
  const value = record[key]
  if (typeof value !== 'string' || value === '') {
    throw new ClifyError('INVALID_PLUGIN', `package.json#${label} must be a string`)
  }
  return value
}

function repositoryField(value: unknown): string {
  if (typeof value === 'string' && value !== '') return value
  if (isRecord(value) && typeof value.url === 'string' && value.url !== '') return value.url
  throw new ClifyError('INVALID_PLUGIN', 'package.json#repository must be a string or { url }')
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), candidate)
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/') && !rel.startsWith('\\'))
}

function isPluginCli(value: unknown): value is PluginCli {
  return isRecord(value) && typeof value.serve === 'function' && typeof value.fetch === 'function'
}

function warnOnNameMismatch(
  cli: PluginCli,
  manifest: PluginManifest,
  options: ValidatePluginOptions,
) {
  const cliName = getCliName(cli)
  if (cliName === null || cliName === manifest.pluginName) return
  options.warn?.(
    `warn: plugin name mismatch — Cli='${cliName}' / package.json clify.name='${manifest.pluginName}' / repo='${options.repoName ?? ''}'`,
  )
}

function getCliName(cli: PluginCli): string | null {
  /* v8 ignore next */
  if (!isRecord(cli)) return null
  if (typeof cli.name === 'string') return cli.name
  if (typeof cli._name === 'string') return cli._name
  if (isRecord(cli.options) && typeof cli.options.name === 'string') return cli.options.name
  return null
}
