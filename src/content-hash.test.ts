import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { contentHash } from './content-hash'

const TEXT = 'Text A'
const AT = 1_700_000_000_000
const NUL = '\u0000'

function sha256(parts: Array<string | Buffer>): string {
  const hash = createHash('sha256')
  for (const part of parts) {
    if (typeof part === 'string') hash.update(part, 'utf8')
    else hash.update(part)
  }
  return hash.digest('hex')
}

describe('contentHash', () => {
  it('includes an empty third field, not omitted, so no-image differs from a digest without the trailing NUL', () => {
    const noImage = contentHash(TEXT, AT, null)
    const withTrailingNul = sha256([TEXT, NUL, String(AT), NUL])
    const withoutTrailingNul = sha256([TEXT, NUL, String(AT)])

    expect(noImage).toBe(withTrailingNul)
    expect(noImage).not.toBe(withoutTrailingNul)
    expect(contentHash(TEXT, AT)).toBe(noImage)
    expect(contentHash(TEXT, AT, Buffer.alloc(0))).toBe(noImage)
  })

  it('distinguishes an image from no image, and a changed scheduledAt from the original', () => {
    const noImage = contentHash(TEXT, AT, null)
    const withImage = contentHash(TEXT, AT, Buffer.from('png-bytes'))
    const later = contentHash(TEXT, AT + 1, null)

    expect(withImage).not.toBe(noImage)
    expect(later).not.toBe(noImage)
    expect(withImage).toBe(sha256([TEXT, NUL, String(AT), NUL, Buffer.from('png-bytes')]))
    expect(later).toBe(sha256([TEXT, NUL, String(AT + 1), NUL]))
  })
})
