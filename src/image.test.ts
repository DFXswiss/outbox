import { describe, expect, it } from 'vitest'
import { imageMime } from './image'

describe('imageMime', () => {
  it('recognizes PNG and JPEG signatures', () => {
    expect(imageMime(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe('image/png')
    expect(imageMime(Buffer.from([0xff, 0xd8, 0xff]))).toBe('image/jpeg')
  })

  it('rejects a JPEG prefix with an invalid third byte', () => {
    expect(imageMime(Buffer.from([0xff, 0xd8, 0x00, 0x01]))).toBeNull()
  })

  it('rejects signatures that are too short or incorrect', () => {
    expect(imageMime(Buffer.from([137, 80, 78, 71, 13, 10, 26]))).toBeNull()
    expect(imageMime(Buffer.from([0xff, 0xd8]))).toBeNull()
    expect(imageMime(Buffer.from('not an image'))).toBeNull()
  })
})
