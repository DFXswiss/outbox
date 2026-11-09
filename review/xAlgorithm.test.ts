import { describe, expect, it } from 'vitest'
import {
  checkPostSpacing,
  suggestsMediaOrLink,
  DEFAULT_MIN_HOURS_BETWEEN_POSTS,
  type SpacingEntry
} from './xAlgorithm'

const HOUR = 60 * 60 * 1000

function entry(id: string, profileId: string, channel: string, scheduledAt: number): SpacingEntry {
  return { id, profileId, channel, scheduledAt }
}

describe('checkPostSpacing', () => {
  it('flags nothing when only one post exists', () => {
    const entries = [entry('a', 'p1', 'x', 0)]
    expect(checkPostSpacing(entries)).toEqual([])
  })

  it('flags nothing when posts are far enough apart', () => {
    const entries = [entry('a', 'p1', 'x', 0), entry('b', 'p1', 'x', 30 * HOUR)]
    expect(checkPostSpacing(entries)).toEqual([])
  })

  it('flags the later post when two posts on the same profile+channel are too close', () => {
    const entries = [entry('a', 'p1', 'x', 0), entry('b', 'p1', 'x', 5 * HOUR)]
    expect(checkPostSpacing(entries)).toEqual(['b'])
  })

  it('does not flag posts on different channels for the same profile', () => {
    const entries = [entry('a', 'p1', 'x', 0), entry('b', 'p1', 'linkedin', 5 * HOUR)]
    expect(checkPostSpacing(entries)).toEqual([])
  })

  it('does not flag posts on the same channel for different profiles', () => {
    const entries = [entry('a', 'p1', 'x', 0), entry('b', 'p2', 'x', 5 * HOUR)]
    expect(checkPostSpacing(entries)).toEqual([])
  })

  it('does not group entries whose concatenated profileId+channel collide', () => {
    // Without a separator, profileId "ab" + channel "c" and "a" + "bc" share
    // the key "abc", so a 5h gap would flag the later post. With a separator
    // they are distinct groups and must not affect each other.
    const entries = [entry('one', 'ab', 'c', 0), entry('two', 'a', 'bc', 5 * HOUR)]
    expect(checkPostSpacing(entries)).toEqual([])
  })

  it('is order-independent — sorts by scheduledAt before comparing', () => {
    const entries = [entry('b', 'p1', 'x', 5 * HOUR), entry('a', 'p1', 'x', 0)]
    expect(checkPostSpacing(entries)).toEqual(['b'])
  })

  it('flags every subsequent post that is too close to its immediate predecessor', () => {
    const entries = [
      entry('a', 'p1', 'x', 0),
      entry('b', 'p1', 'x', 5 * HOUR),
      entry('c', 'p1', 'x', 10 * HOUR)
    ]
    expect(checkPostSpacing(entries)).toEqual(['b', 'c'])
  })

  it('respects a custom minHoursApart threshold', () => {
    const entries = [entry('a', 'p1', 'x', 0), entry('b', 'p1', 'x', 10 * HOUR)]
    expect(checkPostSpacing(entries, 5)).toEqual([])
    expect(checkPostSpacing(entries, 15)).toEqual(['b'])
  })

  it('exports a documented default threshold', () => {
    expect(DEFAULT_MIN_HOURS_BETWEEN_POSTS).toBeGreaterThan(0)
  })
})

describe('suggestsMediaOrLink', () => {
  it('returns null when no visual reference is present', () => {
    expect(suggestsMediaOrLink('Just a plain claim with a link to docs.', false)).toBeNull()
  })

  it('returns null when a visual reference is present but an image is attached', () => {
    expect(suggestsMediaOrLink('See the chart below for details.', true)).toBeNull()
  })

  it('flags a visual reference with no attached image', () => {
    const hint = suggestsMediaOrLink('See the chart below for details.', false)
    expect(hint).not.toBeNull()
    expect(hint).toContain('chart')
  })

  it('matches case-insensitively and on multiple reference phrases', () => {
    expect(suggestsMediaOrLink('SCREENSHOT attached below', false)).toContain('SCREENSHOT')
    expect(suggestsMediaOrLink('as shown in the diagram', false)).not.toBeNull()
  })
})
