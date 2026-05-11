import { spawn } from 'node:child_process'
import { ClifyError, errorMessage } from './errors.js'
import type { RuntimeEnv } from './paths.js'
import type { RefKind } from './source.js'

interface GitResult {
  readonly stdout: string
  readonly stderr: string
}

class GitError extends Error {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number | null

  constructor(args: readonly string[], result: GitResult, exitCode: number | null) {
    super(`git ${args.join(' ')} failed: ${result.stderr.trim() || result.stdout.trim()}`)
    this.name = 'GitError'
    this.stdout = result.stdout
    this.stderr = result.stderr
    this.exitCode = exitCode
  }
}

interface GitOptions {
  readonly cwd?: string
  readonly env?: RuntimeEnv
}

interface ResolvedRemoteRef {
  readonly refKind: Exclude<RefKind, 'default-branch'>
  readonly resolvedRef: string
  readonly sha: string
}

const shaPattern = /^[0-9a-f]{7,40}$/

async function runGit(args: readonly string[], options: GitOptions = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      reject(new GitError(args, { stdout, stderr: stderr || errorMessage(error) }, null))
    })
    child.on('close', (code) => {
      const result = { stdout, stderr }
      if (code === 0) resolve(result)
      else reject(new GitError(args, result, code))
    })
  })
}

export async function resolveRemoteRef(
  url: string,
  ref: string,
  env: RuntimeEnv,
): Promise<ResolvedRemoteRef> {
  if (shaPattern.test(ref)) return { refKind: 'sha', resolvedRef: ref, sha: ref }
  const remote = await runGit(['ls-remote', '--tags', '--heads', url], { env }).catch(
    (error: unknown) => {
      if (error instanceof GitError) {
        throw new ClifyError(
          'INSTALL_FAILED',
          `could not query ${url}: ${error.stderr || error.message}`,
          {
            cause: error,
          },
        )
      }
      /* v8 ignore next */
      throw error
    },
  )
  const refs = parseLsRemote(remote.stdout)
  const peeledTag = refs.get(`refs/tags/${ref}^{}`)
  const tag = refs.get(`refs/tags/${ref}`)
  if (peeledTag !== undefined) return { refKind: 'tag', resolvedRef: ref, sha: peeledTag }
  if (tag !== undefined) return { refKind: 'tag', resolvedRef: ref, sha: tag }
  const branch = refs.get(`refs/heads/${ref}`)
  if (branch !== undefined) return { refKind: 'branch', resolvedRef: ref, sha: branch }
  throw new ClifyError('REF_NOT_FOUND', `ref not found: ${ref}`)
}

export async function cloneDefault(url: string, dir: string, env: RuntimeEnv): Promise<void> {
  await gitInstall(['clone', '--depth', '1', url, dir], env)
}

export async function cloneBranch(
  url: string,
  ref: string,
  dir: string,
  env: RuntimeEnv,
): Promise<void> {
  await gitInstall(['clone', '--depth', '1', '--branch', ref, url, dir], env)
}

export async function cloneTag(
  url: string,
  ref: string,
  dir: string,
  env: RuntimeEnv,
): Promise<void> {
  await gitInstall(['clone', '--depth', '1', '--no-checkout', url, dir], env)
  await gitInstall(
    ['fetch', '--depth', '1', '--force', 'origin', `refs/tags/${ref}:refs/tags/${ref}`],
    env,
    dir,
  )
  await gitInstall(['checkout', `refs/tags/${ref}`], env, dir)
}

export async function cloneSha(
  url: string,
  sha: string,
  dir: string,
  env: RuntimeEnv,
): Promise<void> {
  await gitInstall(['clone', url, dir], env)
  await gitInstall(['checkout', sha], env, dir)
}

export async function currentSha(dir: string, env: RuntimeEnv): Promise<string> {
  const result = await runGit(['rev-parse', 'HEAD'], { cwd: dir, env })
  return result.stdout.trim()
}

export async function currentBranch(dir: string, env: RuntimeEnv): Promise<string> {
  const result = await runGit(['branch', '--show-current'], { cwd: dir, env })
  const branch = result.stdout.trim()
  if (branch !== '') return branch
  const fallback = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir, env })
  return fallback.stdout.trim()
}

export async function fetchBranch(dir: string, branch: string, env: RuntimeEnv): Promise<void> {
  await gitInstall(['fetch', '--depth', '1', 'origin', branch], env, dir)
  await gitInstall(['checkout', 'FETCH_HEAD'], env, dir)
}

export async function fetchTag(dir: string, tag: string, env: RuntimeEnv): Promise<void> {
  await gitInstall(
    ['fetch', '--depth', '1', '--force', 'origin', `refs/tags/${tag}:refs/tags/${tag}`],
    env,
    dir,
  )
  await gitInstall(['checkout', `refs/tags/${tag}`], env, dir)
}

export async function checkoutSha(dir: string, sha: string, env: RuntimeEnv): Promise<void> {
  await gitInstall(['checkout', sha], env, dir)
}

function parseLsRemote(stdout: string): Map<string, string> {
  const refs = new Map<string, string>()
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim() === '') continue
    const [sha, ref] = line.split(/\s+/)
    if (sha !== undefined && ref !== undefined) refs.set(ref, sha)
  }
  return refs
}

async function gitInstall(args: readonly string[], env: RuntimeEnv, cwd?: string): Promise<void> {
  try {
    await runGit(args, cwd === undefined ? { env } : { cwd, env })
  } catch (error) {
    if (error instanceof GitError) {
      throw new ClifyError('INSTALL_FAILED', `${error.stderr.trim() || error.message}`, {
        cause: error,
      })
    }
    /* v8 ignore next */
    throw error
  }
}
