import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ClifyError, isRecord, nodeErrorCode } from './errors.js'
import { withFileLock } from './locks.js'
import type { XdgPaths } from './paths.js'
import type { RefKind } from './source.js'

export interface PluginState {
  readonly id: string
  readonly owner: string
  readonly repo: string
  readonly source: string
  readonly ref: string | null
  readonly refKind: RefKind
  readonly resolvedRef: string
  readonly sha: string
  readonly cacheDir: string
  readonly installedAt: string
  readonly lastFetchAt: string
  readonly lastUsedAt: string
  readonly pluginName: string
  readonly pluginVersion: string
  readonly pluginDescription: string
}

interface StateFile {
  readonly version: 1
  readonly plugins: Record<string, PluginState>
}

function emptyState(): StateFile {
  return { version: 1, plugins: {} }
}

export async function readState(paths: XdgPaths): Promise<StateFile> {
  let raw: string
  try {
    raw = await readFile(paths.stateFile, 'utf8')
  } catch (error) {
    if (nodeErrorCode(error) === 'ENOENT') return emptyState()
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new ClifyError('INSTALL_FAILED', `invalid state file: ${paths.stateFile}`, {
      cause: error,
    })
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.plugins)) {
    throw new ClifyError('INSTALL_FAILED', `invalid state file: ${paths.stateFile}`)
  }
  const plugins: Record<string, PluginState> = {}
  for (const [id, value] of Object.entries(parsed.plugins)) {
    if (!isPluginState(value)) throw new ClifyError('INSTALL_FAILED', `invalid state entry: ${id}`)
    plugins[id] = value
  }
  return { version: 1, plugins }
}

export async function writeState(paths: XdgPaths, state: StateFile): Promise<void> {
  await mkdir(dirname(paths.stateFile), { recursive: true })
  const tmp = `${paths.stateFile}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`)
  await rename(tmp, paths.stateFile)
}

async function updateState(
  paths: XdgPaths,
  update: (state: StateFile) => StateFile,
): Promise<StateFile> {
  return withFileLock(paths.stateLock, async () => {
    const next = update(await readState(paths))
    await writeState(paths, next)
    return next
  })
}

export async function upsertPluginState(paths: XdgPaths, entry: PluginState): Promise<void> {
  await updateState(paths, (state) => ({
    version: 1,
    plugins: { ...state.plugins, [entry.id]: entry },
  }))
}

export async function removePluginState(paths: XdgPaths, id: string): Promise<boolean> {
  let removed = false
  await updateState(paths, (state) => {
    const plugins: Record<string, PluginState> = {}
    for (const [key, value] of Object.entries(state.plugins)) {
      if (key === id) {
        removed = true
      } else {
        plugins[key] = value
      }
    }
    return { version: 1, plugins }
  })
  return removed
}

export async function touchLastUsed(paths: XdgPaths, id: string, isoTime: string): Promise<void> {
  await updateState(paths, (state) => {
    const entry = state.plugins[id]
    if (entry === undefined) return state
    return {
      version: 1,
      plugins: { ...state.plugins, [id]: { ...entry, lastUsedAt: isoTime } },
    }
  })
}

export async function removeCacheDir(cacheDir: string): Promise<void> {
  await rm(cacheDir, { recursive: true, force: true })
}

function isPluginState(value: unknown): value is PluginState {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string' &&
    typeof value.owner === 'string' &&
    typeof value.repo === 'string' &&
    typeof value.source === 'string' &&
    (typeof value.ref === 'string' || value.ref === null) &&
    isRefKind(value.refKind) &&
    typeof value.resolvedRef === 'string' &&
    typeof value.sha === 'string' &&
    typeof value.cacheDir === 'string' &&
    typeof value.installedAt === 'string' &&
    typeof value.lastFetchAt === 'string' &&
    typeof value.lastUsedAt === 'string' &&
    typeof value.pluginName === 'string' &&
    typeof value.pluginVersion === 'string' &&
    typeof value.pluginDescription === 'string'
  )
}

function isRefKind(value: unknown): value is RefKind {
  return value === 'default-branch' || value === 'branch' || value === 'tag' || value === 'sha'
}
