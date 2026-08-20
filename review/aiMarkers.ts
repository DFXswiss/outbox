/**
 * Non-blocking style hints for phrasing that reads as LLM-generated rather
 * than a person's own voice. Generic enough to run on any draft. Pure
 * Node/TypeScript, same portability contract as the rest of `review/`
 * (see `review/README.md`).
 *
 * Deliberately narrow and pattern-based, not a style-model judgment call —
 * a handful of well-known, checkable tells, not an attempt to detect "AI
 * writing" in general (that would be unreliable and easy to game either
 * direction). Like `xAlgorithm.ts`'s checks, these are informational, never
 * blocking: a real person can legitimately write any one of these phrases.
 */

/** Known filler openers/transitions and generic-engagement closers. */
const AI_MARKER_PATTERNS: RegExp[] = [
  /\bin today'?s (?:fast-paced |ever-evolving |digital )?(?:world|landscape|climate)\b/i,
  /\bas we navigate\b/i,
  /\blet'?s (?:dive in|explore|unpack)\b/i,
  /\bit'?s not just [^,.!?]+, it'?s\b/i,
  /\bwhether you'?re [^,]+ or [^,]+,/i,
  /^(?:furthermore|moreover|additionally),/im,
  /\bin conclusion\b/i,
  /\bto sum (?:up|it up)\b/i,
  /\bit'?s (?:important|worth) (?:to note|noting) that\b/i,
  /\bwhat (?:are your thoughts|do you think)\?/i,
  /\blet me know (?:below|in the comments)\b/i
]

/** IDs of matched patterns, source-string form (for reporting which one hit). */
export function checkAiMarkerPhrases(postText: string): string[] {
  return AI_MARKER_PATTERNS.filter((pattern) => pattern.test(postText)).map(
    (pattern) => pattern.source
  )
}

/** Em dashes are a well-known LLM-prose tell in volume, not in isolation. */
export function countEmDashes(text: string): number {
  return (text.match(/—/g) ?? []).length
}

export const DEFAULT_MAX_EM_DASHES = 2

/** True when `text` uses more em dashes than `maxEmDashes` allows. */
export function hasExcessiveEmDashes(
  text: string,
  maxEmDashes: number = DEFAULT_MAX_EM_DASHES
): boolean {
  return countEmDashes(text) > maxEmDashes
}
