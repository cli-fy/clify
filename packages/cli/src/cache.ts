import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { ClifyError } from './errors.js'
import {
  checkoutSha,
  cloneBranch,
  cloneDefault,
  cloneSha,
  cloneTag,
  currentBranch,
  currentSha,
  fetchBranch,
  fetchTag,
  resolveRemoteRef,
} from './git.js'
import { withFileLock } from './locks.js'
import {
  cacheDirFor,
  cacheDirRelative,
  getXdgPaths,
  installLockFor,
  type RuntimeEnv,
  type XdgPaths,
} from './paths.js'
import { type PluginCli, validatePlugin } from './plugin.js'
import { type GitHubSourceSpec, parseSourceSpec } from './source.js'
import {
  type PluginState,
  readState,
  removeCacheDir,
  removePluginState,
  touchLastUsed,
  upsertPluginState,
} from './state.js'

export interface RuntimeContext {
  readonly cwd: string
  readonly env: RuntimeEnv
  readonly stdout: (chunk: string) => void
  readonly stderr: (chunk: string) => void
  readonly now: () => number
  readonly silent: boolean
}

interface EnsureOptions {
  readonly noFetch?: boolean
  readonly reinstall?: boolean
}

interface LoadedPlugin {
  readonly entry: PluginState
  readonly cli: PluginCli
}

interface UpdateResult {
  readonly id: string
  readonly from: string
  readonly to: string
}

const ttlMs = 24 * 60 * 60 * 1000

export async function ensureGitHubPlugin(
  source: GitHubSourceSpec,
  context: RuntimeContext,
  options: EnsureOptions = {},
): Promise<LoadedPlugin> {
  const paths = getXdgPaths(context.env)
  if (options.reinstall === true) await removeInstalledSource(source, paths)
  const state = await readState(paths)
  let entry = state.plugins[source.installId]
  if (entry === undefined) {
    return installGitHubPlugin(source, context)
  }
  if (options.noFetch !== true && shouldTtlRefresh(entry, context.now())) {
    await updateOne(entry, context, false)
    /* v8 ignore next */
    entry = (await readState(paths)).plugins[source.installId] ?? entry
  }
  const loaded = await loadInstalledPlugin(entry, context)
  await touchLastUsed(paths, entry.id, nowIso(context))
  return loaded
}

export async function addGitHubPlugin(
  source: GitHubSourceSpec,
  context: RuntimeContext,
  reinstall: boolean,
): Promise<PluginState> {
  const paths = getXdgPaths(context.env)
  if (reinstall) await removeInstalledSource(source, paths)
  const existing = (await readState(paths)).plugins[source.installId]
  if (existing !== undefined) {
    await loadInstalledPlugin(existing, context)
    return existing
  }
  return (await installGitHubPlugin(source, context)).entry
}

async function installGitHubPlugin(
  source: GitHubSourceSpec,
  context: RuntimeContext,
): Promise<LoadedPlugin> {
  const paths = getXdgPaths(context.env)
  const pluginDir = cacheDirFor(paths, source)
  const lockPath = installLockFor(paths, source)
  return withFileLock(
    lockPath,
    async () => {
      const existing = (await readState(paths)).plugins[source.installId]
      if (existing !== undefined) {
        const validated = await validatePlugin(resolve(paths.cacheRoot, existing.cacheDir), {
          repoName: existing.repo,
          warn: (message) => warn(context, message),
        })
        return { entry: existing, cli: validated.cli }
      }

      await removeCacheDir(pluginDir)
      await mkdir(pluginDir, { recursive: true })
      await removeCacheDir(pluginDir)

      let refKind: PluginState['refKind']
      let resolvedRef: string
      try {
        if (source.ref === null) {
          await cloneDefault(source.url, pluginDir, context.env)
          refKind = 'default-branch'
          resolvedRef = await currentBranch(pluginDir, context.env)
        } else {
          const resolved = await resolveRemoteRef(source.url, source.ref, context.env)
          refKind = resolved.refKind
          resolvedRef = resolved.resolvedRef
          if (resolved.refKind === 'sha')
            await cloneSha(source.url, resolved.sha, pluginDir, context.env)
          else if (resolved.refKind === 'tag')
            await cloneTag(source.url, resolved.resolvedRef, pluginDir, context.env)
          else await cloneBranch(source.url, resolved.resolvedRef, pluginDir, context.env)
        }
      } catch (error) {
        await removeCacheDir(pluginDir)
        throw error
      }

      log(
        context,
        `→ installing ${source.installId} from github.com/${source.owner}/${source.repo}@${resolvedRef}`,
      )
      log(context, '→ this will execute code from this repo during validation and on every run.')

      const sha = await currentSha(pluginDir, context.env)
      const validated = await validateOrRemove(pluginDir, source, context)
      const installedAt = nowIso(context)
      const entry: PluginState = {
        id: source.installId,
        owner: source.owner,
        repo: source.repo,
        source: source.url,
        ref: source.ref,
        refKind,
        resolvedRef,
        sha,
        cacheDir: cacheDirRelative(source),
        installedAt,
        lastFetchAt: installedAt,
        lastUsedAt: installedAt,
        pluginName: validated.manifest.pluginName,
        pluginVersion: validated.manifest.version,
        pluginDescription: validated.manifest.description,
      }
      await upsertPluginState(paths, entry)
      return { entry, cli: validated.cli }
    },
    {
      onWait: () => log(context, `→ waiting for concurrent install of ${source.installId} (~5s)`),
    },
  )
}

export async function loadLocalPlugin(path: string, context: RuntimeContext): Promise<PluginCli> {
  const validated = await validatePlugin(path, { warn: (message) => warn(context, message) })
  return validated.cli
}

export async function updatePlugins(
  ids: readonly string[],
  context: RuntimeContext,
): Promise<UpdateResult[]> {
  const paths = getXdgPaths(context.env)
  const state = await readState(paths)
  const entries =
    ids.length === 0
      ? Object.values(state.plugins)
      : ids.map((id) => installedEntry(state.plugins, id))
  const results: UpdateResult[] = []
  for (const entry of entries) {
    results.push(await updateOne(entry, context, true))
  }
  return results
}

export async function removeManagedPlugin(id: string, context: RuntimeContext): Promise<boolean> {
  const parsed = parseSourceSpec(id, context.cwd, context.env)
  if (parsed.type === 'local')
    throw new ClifyError('LOCAL_NOT_MANAGED', 'local paths are direct-run only')
  const paths = getXdgPaths(context.env)
  const entry = (await readState(paths)).plugins[parsed.installId]
  if (entry === undefined) return false
  await removeCacheDir(resolve(paths.cacheRoot, entry.cacheDir))
  await removePluginState(paths, parsed.installId)
  return true
}

export async function listManagedPlugins(
  context: RuntimeContext,
  full: boolean,
): Promise<Record<string, unknown>[]> {
  const paths = getXdgPaths(context.env)
  const state = await readState(paths)
  const rows: Record<string, unknown>[] = []
  for (const entry of Object.values(state.plugins).sort((a, b) => a.id.localeCompare(b.id))) {
    const row: Record<string, unknown> = {
      id: entry.id,
      version: entry.pluginVersion,
      ref: entry.ref ?? entry.resolvedRef,
      description: entry.pluginDescription,
      source: entry.source.replace('https://', ''),
    }
    if (full) {
      row.installedAt = entry.installedAt
      row.lastFetchAt = entry.lastFetchAt
      row.lastUsedAt = entry.lastUsedAt
      row.diskBytes = await diskBytes(resolve(paths.cacheRoot, entry.cacheDir))
    }
    rows.push(row)
  }
  return rows
}

export async function infoForPlugin(
  source: GitHubSourceSpec,
  context: RuntimeContext,
): Promise<LoadedPlugin> {
  const paths = getXdgPaths(context.env)
  const state = await readState(paths)
  const entry = state.plugins[source.installId]
  if (entry === undefined) return installGitHubPlugin(source, context)
  return loadInstalledPlugin(entry, context)
}

export async function delegateToPlugin(cli: PluginCli, argv: readonly string[]): Promise<number> {
  const result = await cli.serve([...argv])
  return typeof result === 'number' && Number.isFinite(result) ? result : 0
}

export function formatInfo(entry: PluginState, diskBytesValue: number): string {
  return [
    `plugin: ${entry.id}`,
    `  version: ${entry.pluginVersion}`,
    `  ref: ${entry.ref === null ? 'null' : entry.ref}`,
    `  refKind: ${entry.refKind}`,
    `  resolvedRef: ${entry.resolvedRef}`,
    `  sha: ${entry.sha}`,
    `  source: ${entry.source}`,
    `  description: ${entry.pluginDescription}`,
    `  installedAt: ${entry.installedAt}`,
    `  lastFetchAt: ${entry.lastFetchAt}`,
    `  diskBytes: ${diskBytesValue}`,
    '',
    'llms:',
  ].join('\n')
}

export async function diskBytes(path: string): Promise<number> {
  const { readdir, stat } = await import('node:fs/promises')
  let total = 0
  let entries: string[]
  try {
    entries = await readdir(path)
  } catch {
    return 0
  }
  for (const entry of entries) {
    const child = join(path, entry)
    const childStat = await stat(child)
    if (childStat.isDirectory()) total += await diskBytes(child)
    else total += childStat.size
  }
  return total
}

async function loadInstalledPlugin(
  entry: PluginState,
  context: RuntimeContext,
): Promise<LoadedPlugin> {
  const paths = getXdgPaths(context.env)
  const source = sourceFromEntry(entry, context)
  return withFileLock(installLockFor(paths, source), async () => {
    const root = resolve(paths.cacheRoot, entry.cacheDir)
    const validated = await validatePlugin(root, {
      repoName: entry.repo,
      warn: (message) => warn(context, message),
    })
    return { entry, cli: validated.cli }
  })
}

async function updateOne(
  entry: PluginState,
  context: RuntimeContext,
  explicit: boolean,
): Promise<UpdateResult> {
  if (entry.refKind === 'sha') return { id: entry.id, from: '(unchanged)', to: entry.sha }

  const paths = getXdgPaths(context.env)
  const source = sourceFromEntry(entry, context)
  return withFileLock(installLockFor(paths, source), async () => {
    const pluginDir = resolve(paths.cacheRoot, entry.cacheDir)
    const previousSha = entry.sha
    try {
      if (entry.refKind === 'tag') await fetchTag(pluginDir, entry.resolvedRef, context.env)
      else await fetchBranch(pluginDir, entry.resolvedRef, context.env)
    } catch (error) {
      if (!explicit) {
        warn(
          context,
          `warn: could not refresh ${entry.id} (offline?); using cached sha ${previousSha.slice(0, 7)}`,
        )
        return { id: entry.id, from: '(unchanged)', to: previousSha }
      }
      throw error
    }

    const candidateSha = await currentSha(pluginDir, context.env)
    try {
      const validated = await validatePlugin(pluginDir, {
        repoName: entry.repo,
        warn: (message) => warn(context, message),
      })
      const next: PluginState = {
        ...entry,
        sha: candidateSha,
        lastFetchAt: nowIso(context),
        pluginName: validated.manifest.pluginName,
        pluginVersion: validated.manifest.version,
        pluginDescription: validated.manifest.description,
      }
      await upsertPluginState(paths, next)
      return {
        id: entry.id,
        from: candidateSha === previousSha ? '(unchanged)' : previousSha,
        to: candidateSha,
      }
    } catch (error) {
      await checkoutSha(pluginDir, previousSha, context.env)
      if (!explicit) {
        /* v8 ignore next */
        const code = error instanceof ClifyError ? error.code : 'INVALID_PLUGIN'
        warn(
          context,
          `warn: could not refresh ${entry.id} (${code}); using cached sha ${previousSha.slice(0, 7)}`,
        )
        return { id: entry.id, from: '(unchanged)', to: previousSha }
      }
      throw error
    }
  })
}

async function validateOrRemove(
  pluginDir: string,
  source: GitHubSourceSpec,
  context: RuntimeContext,
) {
  try {
    return await validatePlugin(pluginDir, {
      repoName: source.repo,
      warn: (message) => warn(context, message),
    })
  } catch (error) {
    await removeCacheDir(pluginDir)
    throw error
  }
}

async function removeInstalledSource(source: GitHubSourceSpec, paths: XdgPaths): Promise<void> {
  const entry = (await readState(paths)).plugins[source.installId]
  await removeCacheDir(
    entry === undefined ? cacheDirFor(paths, source) : resolve(paths.cacheRoot, entry.cacheDir),
  )
  await removePluginState(paths, source.installId)
}

function installedEntry(plugins: Record<string, PluginState>, id: string): PluginState {
  const entry = plugins[id]
  if (entry === undefined)
    throw new ClifyError('PLUGIN_NOT_INSTALLED', `plugin is not installed: ${id}`)
  return entry
}

function shouldTtlRefresh(entry: PluginState, now: number): boolean {
  if (entry.refKind !== 'default-branch' && entry.refKind !== 'branch') return false
  return now - new Date(entry.lastFetchAt).getTime() > ttlMs
}

function sourceFromEntry(entry: PluginState, context: RuntimeContext): GitHubSourceSpec {
  const parsed = parseSourceSpec(entry.id, context.cwd, context.env)
  /* v8 ignore next */
  if (parsed.type === 'local')
    throw new ClifyError('LOCAL_NOT_MANAGED', 'local paths are direct-run only')
  return parsed
}

function nowIso(context: RuntimeContext): string {
  return new Date(context.now()).toISOString()
}

function log(context: RuntimeContext, message: string) {
  if (!context.silent) context.stderr(`${message}\n`)
}

function warn(context: RuntimeContext, message: string) {
  if (!context.silent) context.stderr(`${message}\n`)
}
