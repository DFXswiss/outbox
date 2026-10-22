import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { comparePngSets, findSensitiveText, findUnexpectedTokens, gateBuiltHandbook, levenshteinAtMostOne, tokenize, validateQrAllowlist } from './content-gate'

const roots: string[] = []

function gateFixture(): { root: string; built: string } {
  const root = mkdtempSync(join(tmpdir(), 'outbox-content-gate-test-'))
  roots.push(root)
  const built = join(root, 'built')
  const repo = join(root, 'repo')
  mkdirSync(join(built, 'screenshots', 'chapter'), { recursive: true })
  mkdirSync(join(repo, 'src'), { recursive: true })
  mkdirSync(join(repo, 'review'), { recursive: true })
  mkdirSync(join(repo, 'docs', 'handbook'), { recursive: true })
  mkdirSync(join(repo, 'scripts', 'handbook'), { recursive: true })
  writeFileSync(join(repo, 'src', 'terms.ts'), "export const status = 'status'\n")
  writeFileSync(join(repo, 'scripts', 'handbook', 'capture.mjs'), '')
  writeFileSync(join(repo, 'docs', 'handbook', 'intro.md'), '# Intro\n')
  writeFileSync(join(built, 'manifest.json'), JSON.stringify({ artifacts: [{ category: 'screenshot', outputPath: 'screenshots/chapter/page.png' }] }))
  writeFileSync(join(built, 'screenshots', 'chapter', 'page.png'), 'png')
  return { root: repo, built }
}

function successfulTool(name: string, stdout = 'status handbook'): { status: number; stdout: string; stderr: string } {
  return name === 'zbarimg' ? { status: 4, stdout: '', stderr: '' } : { status: 0, stdout, stderr: '' }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('handbook content gate rules', () => {
  it('requires the manifest image set to match the disk image set exactly', () => {
    expect(comparePngSets(['screenshots/A.png'], ['screenshots/a.PNG'])).toContain('case-colliding image paths: screenshots/A.png, screenshots/a.PNG')
    expect(comparePngSets(['screenshots/A.png'], ['screenshots/a.png'])).toEqual([
      'case-colliding image paths: screenshots/A.png, screenshots/a.png',
      'manifest image missing on disk: screenshots/A.png',
      'unmanifested image on disk: screenshots/a.png'
    ])
    expect(comparePngSets(['screenshots/a.png'], ['screenshots/b.png'])).toContain('manifest image missing on disk: screenshots/a.png')
    expect(comparePngSets([], [])).toContain('the built image set is empty')
    expect(comparePngSets([], ['screenshots/orphan.png'])).toContain('unmanifested image on disk: screenshots/orphan.png')
    expect(comparePngSets(
      ['screenshots/page.png', 'assets/fonts/Inter-Regular.woff2'],
      ['screenshots/page.png', 'assets/fonts/Inter-Regular.woff2']
    )).toEqual([])
  })

  it('requires allowlisted QR entries to have both a file and a decoded payload', () => {
    const allowlist = { 'screenshots/code.png': [/^https:\/\/x\.com\//] }
    expect(validateQrAllowlist(allowlist, ['screenshots/code.png'], { 'screenshots/code.png': ['https://x.com/handbook_demo'] })).toEqual([])
    expect(validateQrAllowlist(allowlist, [], {})).toEqual([
      'QR allowlist entry has no QR payload: screenshots/code.png',
      'QR allowlist entry has no image: screenshots/code.png',
      'QR allowlist pattern matches no payload: screenshots/code.png: /^https:\\/\\/x\\.com\\//'
    ])
    expect(validateQrAllowlist({}, ['screenshots/code.png'], { 'screenshots/code.png': ['https://example.invalid'] })).toContain('unexpected QR payload in screenshots/code.png: https://example.invalid')
    expect(validateQrAllowlist({ 'screenshots/code.png': [/^https:\/\/elsewhere\.com\//] }, ['screenshots/code.png'], { 'screenshots/code.png': ['https://x.com/post'] })
      .some((error) => error.startsWith('QR allowlist pattern matches no payload: screenshots/code.png: '))).toBe(true)
    expect(validateQrAllowlist({ 'screenshots/code.png': [/x/g] }, ['screenshots/code.png'], { 'screenshots/code.png': ['x'] }))
      .toContain('QR allowlist pattern must not use g or y flags: screenshots/code.png: /x/g')
    expect(validateQrAllowlist({ 'screenshots/Code.png': [/^https:\/\/x\.com\//] }, ['screenshots/code.png'], { 'screenshots/code.png': ['https://x.com/post'] }))
      .toContain('QR allowlist entry has no image: screenshots/Code.png')
  })

  it('allows OCR tokens from source vocabulary and one-character noise', () => {
    const vocabulary = new Set(tokenize('composer submitted status'))
    expect(findUnexpectedTokens('screen.png', 'composr submitted', vocabulary)).toEqual([])
    expect(findUnexpectedTokens('screen.png', 'unlistedword', vocabulary)).toEqual(['unexpected OCR token "unlistedword"'])
    expect(levenshteinAtMostOne('status', 'statuz')).toBe(true)
    expect(levenshteinAtMostOne('status', 'stazuz')).toBe(false)
    expect(findUnexpectedTokens('screen.png', 'stazuz', new Set(['status']))).toEqual([
      'unexpected OCR token "stazuz"'
    ])
  })

  it('does not apply OCR typo tolerance to four-letter vocabulary words', () => {
    expect(findUnexpectedTokens('screen.png', 'sand', new Set(['send']))).toEqual([
      'unexpected OCR token "sand"'
    ])
  })

  it('blocks token-like secrets, addresses, and non-X URLs', () => {
    expect(findSensitiveText('screen.png', 'eyJabcdefghijklmno user@example.invalid abcdef0123456789abcdef012345 https://example.invalid')).toEqual([
      'JWT-like text detected',
      'email address detected',
      'long encoded value detected',
      'URL host is not allowed: example.invalid'
    ])
    expect(findSensitiveText('screen.png', 'https://x.com/handbook_demo/status/12345')).toEqual([])
  })

  it('requires zbarimg when the QR decoder is unavailable', () => {
    const { root, built } = gateFixture()
    expect(() => gateBuiltHandbook(built, root, () => ({
      status: null, stdout: '', stderr: '', error: Object.assign(new Error('missing'), { code: 'ENOENT' })
    }))).toThrow('zbarimg is required')
  })

  it('requires tesseract when OCR is unavailable', () => {
    const { root, built } = gateFixture()
    expect(() => gateBuiltHandbook(built, root, (name) => name === 'zbarimg'
      ? { status: 4, stdout: '', stderr: '' }
      : { status: null, stdout: '', stderr: '', error: Object.assign(new Error('missing'), { code: 'ENOENT' }) }
    )).toThrow('tesseract is required')
  })

  it('reports OCR with too few tokens, unknown words, and a low total token count', () => {
    const oneToken = gateFixture()
    const tooLittle = gateBuiltHandbook(oneToken.built, oneToken.root, (name) => successfulTool(name, 'status'))
    expect(tooLittle.some((problem) => problem.message === 'OCR yielded too little, the text check would be vacuous')).toBe(true)

    const unknown = gateFixture()
    const unexpected = gateBuiltHandbook(unknown.built, unknown.root, (name) => successfulTool(name, 'status zzqvword'))
    expect(unexpected.some((problem) => problem.message.includes('unexpected OCR token "zzqvword"'))).toBe(true)

    const lowTotal = gateFixture()
    const tooFewOverall = gateBuiltHandbook(lowTotal.built, lowTotal.root, (name) => successfulTool(name, 'status handbook'))
    expect(tooFewOverall.some((problem) => problem.message.includes('below the minimum'))).toBe(true)
  })
})
