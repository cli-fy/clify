import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { GitHubSourceSpec } from './source.js'

export interface RuntimeEnv {
  readonly [key: string]: string | undefined
}

export interface XdgPaths {
  readonly cacheRoot: string
  readonly pluginRoot: string
  readonly stateRoot: string
  readonly stateFile: string
  readonly stateLock: string
  readonly lockRoot: string
}

export function getXdgPaths(env: RuntimeEnv = process.env): XdgPaths {
  const home = env.HOME ?? homedir()
  const cacheHome = env.XDG_CACHE_HOME ?? join(home, '.cache')
  const stateHome = env.XDG_STATE_HOME ?? join(home, '.local/state')
  const cacheRoot = resolve(cacheHome, 'clify')
  const stateRoot = resolve(stateHome, 'clify')
  return {
    cacheRoot,
    pluginRoot: join(cacheRoot, 'plugins'),
    stateRoot,
    stateFile: join(stateRoot, 'state.json'),
    stateLock: join(stateRoot, 'state.lock'),
    lockRoot: join(stateRoot, 'locks'),
  }
}

export function cacheDirFor(paths: XdgPaths, source: GitHubSourceSpec): string {
  return join(paths.pluginRoot, source.owner, source.repo, source.refDir)
}

export function cacheDirRelative(source: GitHubSourceSpec): string {
  return `plugins/${source.owner}/${source.repo}/${source.refDir}`
}

export function installLockFor(paths: XdgPaths, source: GitHubSourceSpec): string {
  return join(paths.lockRoot, `${source.owner}__${source.repo}__${source.refDir}.lock`)
}
