import { describe, expect, it } from 'vitest'
import { characterCount } from './findings'

describe('X weighted character count', () => {
  it('counts CJK and emoji with weight two', () => {
    expect(characterCount('漢😀')).toBe(4)
  })

  it('counts URLs as 23 characters and normalizes Unicode to NFC', () => {
    expect(characterCount('https://example.com/a')).toBe(23)
    expect(characterCount('e\u0301')).toBe(characterCount('é'))
  })
})
