import { describe, expect, it } from 'vitest'
import {
  checkAiMarkerPhrases,
  countEmDashes,
  DEFAULT_MAX_EM_DASHES,
  hasExcessiveEmDashes
} from './aiMarkers'

describe('checkAiMarkerPhrases', () => {
  it('returns an empty array for plain, direct text', () => {
    expect(checkAiMarkerPhrases('DFX lets you buy crypto with SEPA. Non-custodial.')).toEqual([])
  })

  it.each([
    "In today's fast-paced world, crypto moves quickly.",
    'As we navigate this new landscape, things change.',
    "Let's dive in and explore the details.",
    "It's not just a wallet, it's a movement.",
    "Whether you're a beginner or a pro, this helps.",
    'Furthermore, the protocol scales well.',
    'In conclusion, this is the future.',
    'To sum up, crypto is changing finance.',
    "It's important to note that fees vary.",
    'What are your thoughts?',
    'Let me know in the comments.'
  ])('flags a known filler/closer phrase: %s', (text) => {
    expect(checkAiMarkerPhrases(text).length).toBeGreaterThan(0)
  })

  it('can flag more than one pattern in the same text', () => {
    const text = "In today's world, let's dive in. In conclusion, it works."
    expect(checkAiMarkerPhrases(text).length).toBeGreaterThanOrEqual(2)
  })
})

describe('countEmDashes / hasExcessiveEmDashes', () => {
  it('counts zero em dashes in plain text', () => {
    expect(countEmDashes('No dashes here, just a comma.')).toBe(0)
  })

  it('counts multiple em dashes correctly', () => {
    expect(countEmDashes('One — two — three — four.')).toBe(3)
  })

  it('does not flag text at or under the default threshold', () => {
    expect(hasExcessiveEmDashes('One — two.')).toBe(false)
    expect(hasExcessiveEmDashes('')).toBe(false)
  })

  it('flags text over the default threshold', () => {
    expect(hasExcessiveEmDashes('One — two — three — four.')).toBe(true)
  })

  it('respects a custom threshold', () => {
    const text = 'One — two — three.'
    expect(hasExcessiveEmDashes(text, 1)).toBe(true)
    expect(hasExcessiveEmDashes(text, 5)).toBe(false)
  })

  it('exports a documented positive default threshold', () => {
    expect(DEFAULT_MAX_EM_DASHES).toBeGreaterThan(0)
  })
})
