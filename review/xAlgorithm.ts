/**
 * Automated checks derived from `content/x-algorithm-rules.md` (rules
 * approved 2026-08-15). Pure Node/TypeScript — no Electron or React imports,
 * same portability contract as the rest of `review/` (see `review/README.md`).
 * Deliberately does NOT import `ScheduledPost`/`ChannelId` from an
 * app-shell model module — that would break portability — so
 * callers pass a minimal, structurally-compatible shape instead.
 */

/** Minimal shape a caller adapts a real ScheduledPost/campaign entry into. */
export interface SpacingEntry {
  id: string
  profileId: string
  channel: string
  scheduledAt: number // epoch ms
}

/** Default spacing floor: a project judgment call, not a literal algorithm constant.
 * See rule 7 in `content/x-algorithm-rules.md` — the algorithm devalues repeat
 * same-author posts in a session but does not publish an hour threshold. 20h
 * comfortably allows a ~2-day cadence while catching same-day stacking. */
export const DEFAULT_MIN_HOURS_BETWEEN_POSTS = 20

const MS_PER_HOUR = 60 * 60 * 1000

/**
 * IDs of entries scheduled too close (same profileId + channel) to an
 * earlier-scheduled entry. Only the later of each too-close pair is flagged —
 * the earlier one is the anchor other posts must keep distance from.
 */
export function checkPostSpacing(
  entries: SpacingEntry[],
  minHoursApart: number = DEFAULT_MIN_HOURS_BETWEEN_POSTS
): string[] {
  const minGapMs = minHoursApart * MS_PER_HOUR
  const byGroup = new Map<string, SpacingEntry[]>()
  for (const entry of entries) {
    const key = `${entry.profileId}\u0000${entry.channel}`
    const group = byGroup.get(key)
    if (group) group.push(entry)
    else byGroup.set(key, [entry])
  }

  const flagged: string[] = []
  for (const group of byGroup.values()) {
    const sorted = [...group].sort((a, b) => a.scheduledAt - b.scheduledAt)
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i]!.scheduledAt - sorted[i - 1]!.scheduledAt < minGapMs) {
        flagged.push(sorted[i]!.id)
      }
    }
  }
  return flagged
}

/** Phrases that imply the post refers to a visual the reader can't see without media. */
const MEDIA_REFERENCE_PATTERN =
  /\b(chart|screenshot|graphic|infographic|diagram|see (the )?image|see below|as shown|pictured)\b/i

/**
 * A non-blocking hint: the draft's text implies a visual (chart, screenshot,
 * "see below", ...) but no image is attached. Returns `null` when there's
 * nothing to flag — no reference found, or an image is already attached.
 */
export function suggestsMediaOrLink(postText: string, hasImage: boolean): string | null {
  if (hasImage) return null
  const match = MEDIA_REFERENCE_PATTERN.exec(postText)
  if (!match) return null
  return `Text references "${match[0]}" but no image is attached — attach one or drop the reference.`
}
