import { describe, expect, it } from 'vitest'
import { ClifyError } from '../src/errors'
import { looksLikeSourceSpec, parseSourceSpec, refToDir } from '../src/source'

const cwd = '/tmp/clify-work'

function expectInvalid(input: string) {
  expect(() => parseSourceSpec(input, cwd)).toThrow(ClifyError)
}

describe('source parser edge cases', () => {
  it('recognizes only source-like tokens before parsing', () => {
    expect(looksLikeSourceSpec('owner/repo')).toBe(true)
    expect(looksLikeSourceSpec('./plugin')).toBe(true)
    expect(looksLikeSourceSpec('bogus')).toBe(false)
  })

  it('rejects invalid URLs, query strings, fragments, and path forms', () => {
    expectInvalid('https://github.com/owner/repo?x=1')
    expectInvalid('https://github.com/owner/repo#readme')
    expectInvalid('https://github.com/owner/repo/tree/main')
    expectInvalid('ftp://github.com/owner/repo')
    expectInvalid('https://[::1')
  })

  it('enforces owner, repo, and ref constraints', () => {
    expectInvalid('bad-/repo')
    expectInvalid('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/repo')
    expectInvalid('owner/..')
    expectInvalid('owner/repo@')
    expectInvalid('owner/repo@bad\u0001ref')
  })

  it('encodes ref directory separators and percent signs distinctly', () => {
    expect(refToDir('feature/search%2')).toBe('ref-feature%2Fsearch%252')
    expect(refToDir('feature\\search')).toBe('ref-feature%5Csearch')
    expect(parseSourceSpec('https://github.com/Owner/Repo', cwd)).toMatchObject({
      installId: 'owner/repo',
    })
    expect(parseSourceSpec('~/plugin', cwd)).toMatchObject({ path: '/plugin' })
    expect(parseSourceSpec('Owner/Repo@default', cwd)).toMatchObject({
      installId: 'owner/repo@default',
      refDir: 'ref-default',
    })
  })
})
