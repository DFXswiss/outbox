import { describe, expect, it } from 'vitest'
import {
  CHANNEL_IDS,
  CHANNEL_STATUSES,
  ChannelIdSchema,
  ChannelStatusSchema,
  ENTRY_STATES,
  EntryStateSchema,
  PublishResultSchema
} from './status'

describe('ChannelId', () => {
  it('pins the phase-1 value set to x only', () => {
    expect(CHANNEL_IDS).toEqual(['x'])
  })

  it.each([...CHANNEL_IDS])('accepts allowed value %s', (value) => {
    expect(ChannelIdSchema.parse(value)).toBe(value)
  })

  it.each(['telegram', 'linkedin', 'nostr', 'X', ''])(
    'rejects unknown value %s',
    (value) => {
      expect(ChannelIdSchema.safeParse(value).success).toBe(false)
    }
  )
})

describe('EntryState', () => {
  it('pins the spec value set', () => {
    expect(ENTRY_STATES).toEqual(['submitted', 'retracted', 'approved', 'rejected'])
  })

  it.each([...ENTRY_STATES])('accepts allowed value %s', (value) => {
    expect(EntryStateSchema.parse(value)).toBe(value)
  })

  it.each(['pending', 'queued', 'draft', 'Published', ''])(
    'rejects unknown value %s',
    (value) => {
      expect(EntryStateSchema.safeParse(value).success).toBe(false)
    }
  )
})

describe('ChannelStatus', () => {
  it('pins the spec value set', () => {
    expect(CHANNEL_STATUSES).toEqual([
      'pending',
      'in-flight',
      'sent',
      'failed',
      'uncertain'
    ])
  })

  it.each([...CHANNEL_STATUSES])('accepts allowed value %s', (value) => {
    expect(ChannelStatusSchema.parse(value)).toBe(value)
  })

  it.each(['done', 'error', 'retry', 'inflight', 'ok', ''])(
    'rejects unknown value %s',
    (value) => {
      expect(ChannelStatusSchema.safeParse(value).success).toBe(false)
    }
  )
})

describe('PublishResult', () => {
  it('accepts the spec shape with required fields only', () => {
    expect(PublishResultSchema.parse({ channel: 'x', ok: true })).toEqual({
      channel: 'x',
      ok: true
    })
    expect(PublishResultSchema.parse({ channel: 'x', ok: false })).toEqual({
      channel: 'x',
      ok: false
    })
  })

  it('accepts optional url, error, and uncertain', () => {
    expect(
      PublishResultSchema.parse({
        channel: 'x',
        ok: true,
        url: 'https://x.com/example/status/1',
        uncertain: false
      })
    ).toMatchObject({ url: 'https://x.com/example/status/1', uncertain: false })
  })

  it('rejects a non-boolean ok — ok is not the channel status', () => {
    expect(
      PublishResultSchema.safeParse({ channel: 'x', ok: 'sent' }).success
    ).toBe(false)
    expect(PublishResultSchema.safeParse({ channel: 'x', ok: 1 }).success).toBe(
      false
    )
  })

  it('rejects a missing channel or an unknown channel', () => {
    expect(PublishResultSchema.safeParse({ ok: true }).success).toBe(false)
    expect(
      PublishResultSchema.safeParse({ channel: 'telegram', ok: true }).success
    ).toBe(false)
  })
})
