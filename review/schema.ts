/**
 * Zod schema for `content/<topic>/rules.json`. Portable: no Electron or
 * React imports. Regex fields are source strings; the engine compiles them
 * with the `i` flag.
 */
import { z } from 'zod'

export const TopicRulesSchema = z.object({
  topic: z.string().min(1),
  forbiddenClaims: z.array(z.string()),
  provisionalParameters: z.array(z.string()).default([]),
  micarUnsafe: z.array(z.string()).default([]),
  maxEmoji: z.number().int().nonnegative().default(3)
})

export type TopicRules = z.infer<typeof TopicRulesSchema>
