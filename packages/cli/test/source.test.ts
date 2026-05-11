import { describe, expect, it } from 'vitest'
import { ClifyError } from '../src/errors'
import { parseSourceSpec, refToDir } from '../src/source'

const cwd = '/tmp/clify-work'

function expectCode(fn: () => unknown, code: string) {
  expect(fn).toThrow(ClifyError)
  try {
    fn()
  } catch (error) {
    expect(error).toMatchObject({ code })
  }
}

describe('source spec parsing', () => {
  it('normalizes GitHub plugin ids and preserves explicit refs', () => {
    expect(parseSourceSpec('Google/Maps@feature/search', cwd)).toMatchObject({
      type: 'github',
      owner: 'google',
      repo: 'maps',
      ref: 'feature/search',
      refKindHint: null,
      installId: 'google/maps@feature/search',
      url: 'https://github.com/google/maps',
      refDir: 'ref-feature%2Fsearch',
    })
  })

  it('accepts tags, sha-looking refs, and repo punctuation', () => {
    expect(parseSourceSpec('cli-fy/hacker.news_2@a1b2c3d', cwd)).toMatchObject({
      owner: 'cli-fy',
      repo: 'hacker.news_2',
      ref: 'a1b2c3d',
      refKindHint: 'sha',
    })
    expect(refToDir('v1.2.3')).toBe('ref-v1.2.3')
  })

  it('normalizes GitHub URLs and upgrades http to https', () => {
    expect(parseSourceSpec('http://github.com/Google/Maps.git/', cwd)).toMatchObject({
      type: 'github',
      owner: 'google',
      repo: 'maps',
      ref: null,
      installId: 'google/maps',
      url: 'https://github.com/google/maps',
      refDir: 'default',
    })
  })

  it('resolves local paths without treating them as managed installs', () => {
    expect(parseSourceSpec('./plugin', cwd)).toMatchObject({
      type: 'local',
      path: '/tmp/clify-work/plugin',
    })
    expect(parseSourceSpec('~/plugin', cwd, { HOME: '/home/alice' })).toMatchObject({
      type: 'local',
      path: '/home/alice/plugin',
    })
  })

  it('rejects invalid GitHub ids and unsupported URL forms', () => {
    expectCode(() => parseSourceSpec('-bad/repo', cwd), 'INVALID_SOURCE_SPEC')
    expectCode(() => parseSourceSpec('owner/.', cwd), 'INVALID_SOURCE_SPEC')
    expectCode(() => parseSourceSpec('owner/repo@-branch', cwd), 'INVALID_SOURCE_SPEC')
    expectCode(() => parseSourceSpec('owner/repo@feature..x', cwd), 'INVALID_SOURCE_SPEC')
    expectCode(
      () => parseSourceSpec('https://github.com/owner/repo/tree/main', cwd),
      'INVALID_SOURCE_SPEC',
    )
    expectCode(() => parseSourceSpec('https://gitlab.com/owner/repo', cwd), 'INVALID_SOURCE_SPEC')
  })
})
