import { z } from 'zod'

/** Phase 1 channel. Spec: X only. A later channel is one more member of this union. */
export const CHANNEL_IDS = ['x'] as const
export const ChannelIdSchema = z.enum(CHANNEL_IDS)
export type ChannelId = (typeof CHANNEL_IDS)[number]

/** Entry lifecycle. Spec: submit creates submitted; retract/decide are CAS from submitted. */
export const ENTRY_STATES = ['submitted', 'retracted', 'approved', 'rejected'] as const
export const EntryStateSchema = z.enum(ENTRY_STATES)
export type EntryState = (typeof ENTRY_STATES)[number]

/**
 * Queue-row status. Spec: pending | in-flight | sent | failed | uncertain.
 * uncertain is never auto-retried.
 */
export const CHANNEL_STATUSES = [
  'pending',
  'in-flight',
  'sent',
  'failed',
  'uncertain'
] as const
export const ChannelStatusSchema = z.enum(CHANNEL_STATUSES)
export type ChannelStatus = (typeof CHANNEL_STATUSES)[number]

/**
 * Per-channel publish outcome. Spec: `{ channel, ok, url?, error?, uncertain? }`.
 * `ok` is a JSON boolean and is not the channel status — the spec says that expressly.
 */
export const PublishResultSchema = z.object({
  channel: ChannelIdSchema,
  ok: z.boolean(),
  url: z.string().optional(),
  error: z.string().optional(),
  uncertain: z.boolean().optional()
})
export type PublishResult = z.infer<typeof PublishResultSchema>
