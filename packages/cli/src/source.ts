import { resolve } from 'node:path'
import { ClifyError } from './errors.js'

export type RefKind = 'default-branch' | 'branch' | 'tag' | 'sha'

export interface GitHubSourceSpec {
  readonly type: 'github'
  readonly input: string
  readonly owner: string
  readonly repo: string
  readonly ref: string | null
  readonly refKindHint: 'sha' | null
  readonly installId: string
  readonly url: string
  readonly refDir: string
}

interface LocalSourceSpec {
  readonly type: 'local'
  readonly input: string
  readonly path: string
}

type SourceSpec = GitHubSourceSpec | LocalSourceSpec

interface SourceEnv {
  readonly HOME?: string
}

const ownerPattern = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i
const repoPattern = /^[a-z0-9._-]+$/i
const shaPattern = /^[0-9a-f]{7,40}$/

export function looksLikeSourceSpec(input: string): boolean {
  return (
    isLocalPathSpec(input) ||
    input.startsWith('https://') ||
    input.startsWith('http://') ||
    input.includes('/')
  )
}

export function parseSourceSpec(input: string, cwd: string, env: SourceEnv = {}): SourceSpec {
  if (isLocalPathSpec(input)) return parseLocalSpec(input, cwd, env)
  if (input.startsWith('https://') || input.startsWith('http://')) return parseGitHubUrl(input)
  return parseGitHubId(input)
}

export function refToDir(ref: string | null): string {
  if (ref === null) return 'default'
  let encoded = ''
  for (const char of ref) {
    if (char === '%') encoded += '%25'
    else if (char === '/') encoded += '%2F'
    else if (char === '\\') encoded += '%5C'
    else encoded += char
  }
  return `ref-${encoded}`
}

function parseLocalSpec(input: string, cwd: string, env: SourceEnv): LocalSourceSpec {
  const expanded = input.startsWith('~/') ? `${env.HOME ?? ''}${input.slice(1)}` : input
  return { type: 'local', input, path: resolve(cwd, expanded) }
}

function parseGitHubUrl(input: string): GitHubSourceSpec {
  let url: URL
  try {
    url = new URL(input)
  } catch (error) {
    throw invalid(`invalid URL: ${input}`, error)
  }
  if (url.hostname !== 'github.com') throw invalid('only github.com URLs are supported')
  if (url.search !== '' || url.hash !== '')
    throw invalid('GitHub URL query strings and fragments are not supported')

  let pathname = decodeURIComponent(url.pathname)
  if (pathname.endsWith('/')) pathname = pathname.slice(0, -1)
  const parts = pathname.split('/').filter(Boolean)
  const owner = parts[0]
  const rawRepo = parts[1]
  if (parts.length !== 2 || owner === undefined || rawRepo === undefined) {
    throw invalid('GitHub URLs must be https://github.com/<owner>/<repo>')
  }
  const repo = rawRepo.endsWith('.git') ? rawRepo.slice(0, -4) : rawRepo
  return createGitHubSpec(input, owner, repo, null)
}

function parseGitHubId(input: string): GitHubSourceSpec {
  const at = input.indexOf('@')
  const id = at === -1 ? input : input.slice(0, at)
  const ref = at === -1 ? null : input.slice(at + 1)
  const parts = id.split('/')
  const owner = parts[0]
  const repo = parts[1]
  if (parts.length !== 2 || owner === undefined || repo === undefined) {
    throw invalid('plugin id must be <owner>/<repo>')
  }
  return createGitHubSpec(input, owner, repo, ref)
}

function createGitHubSpec(
  input: string,
  rawOwner: string,
  rawRepo: string,
  rawRef: string | null,
): GitHubSourceSpec {
  const owner = rawOwner.toLowerCase()
  const repo = rawRepo.toLowerCase()
  validateOwner(owner)
  validateRepo(repo)
  validateRef(rawRef)
  const installId = rawRef === null ? `${owner}/${repo}` : `${owner}/${repo}@${rawRef}`
  return {
    type: 'github',
    input,
    owner,
    repo,
    ref: rawRef,
    refKindHint: rawRef !== null && shaPattern.test(rawRef) ? 'sha' : null,
    installId,
    url: `https://github.com/${owner}/${repo}`,
    refDir: refToDir(rawRef),
  }
}

function validateOwner(owner: string) {
  if (!ownerPattern.test(owner)) throw invalid('invalid GitHub owner')
}

function validateRepo(repo: string) {
  if (
    repo === '' ||
    repo === '.' ||
    repo === '..' ||
    repo.includes('/') ||
    !repoPattern.test(repo)
  ) {
    throw invalid('invalid GitHub repository')
  }
}

function validateRef(ref: string | null) {
  if (ref === null) return
  if (ref === '') throw invalid('ref must be non-empty')
  if (ref.startsWith('-')) throw invalid('ref must not start with -')
  if (ref.includes('..')) throw invalid('ref must not contain ..')
  if (hasControlCharacter(ref)) throw invalid('ref must not contain control characters')
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

function isLocalPathSpec(input: string): boolean {
  return (
    input.startsWith('./') ||
    input.startsWith('../') ||
    input.startsWith('/') ||
    input.startsWith('~/')
  )
}

function invalid(message: string, cause?: unknown): ClifyError {
  if (cause instanceof Error) return new ClifyError('INVALID_SOURCE_SPEC', message, { cause })
  return new ClifyError('INVALID_SOURCE_SPEC', message)
}
