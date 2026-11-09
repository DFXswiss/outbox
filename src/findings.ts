import {
  checkEmojiCount,
  checkForbiddenClaims,
  checkMicarUnsafe,
  checkProvisionalQualifier,
  checkSentenceLength,
  loadTopicRules,
  type TopicRules
} from '../review/engine'
import type { EntryChecks } from './entries'

const X_CHAR_LIMIT = 280

/**
 * Shown next to findings so a green result is not read as a content
 * approval. Provisional parameters from the pack are checked; whether
 * numbers, names, and claims are factually true is not.
 */
export const REVIEW_SCOPE =
  'Checked: forbidden phrasing, MiCAR wording, a qualifier on provisional parameters listed in the rules, emoji count, sentence length, and character count. Not checked: whether numbers, names, and claims in the text are factually true — the author stands for those.'

export function loadPackRules(packRoot: string, brand: string): TopicRules | null {
  try {
    return loadTopicRules(packRoot, brand)
  } catch {
    return null
  }
}

export type ReviewRun =
  | { ok: false; reason: 'missing-pack' }
  | { ok: true; checks: EntryChecks }

export function reviewText(packRoot: string, brand: string, text: string): ReviewRun {
  const rules = loadPackRules(packRoot, brand)
  if (rules === null) return { ok: false, reason: 'missing-pack' }

  const entries = [{ id: 'draft', postText: text, templateParams: {} }]
  const blocking: string[] = []
  const hints: string[] = []

  for (const hit of checkForbiddenClaims(entries, rules)) {
    blocking.push(`Forbidden claim: ${hit.match}`)
  }
  for (const hit of checkMicarUnsafe(entries, rules)) {
    blocking.push(`MiCAR-unsafe wording: ${hit.match}`)
  }
  const provisional = checkProvisionalQualifier(entries, rules)
  blocking.push(
    ...provisional.missing.map(() => 'Provisional parameter without a qualifier.')
  )
  if (checkEmojiCount(entries, rules.maxEmoji).length > 0) {
    hints.push(`More than ${rules.maxEmoji} emoji.`)
  }
  if (checkSentenceLength(entries).length > 0) {
    hints.push('A sentence is longer than 35 words.')
  }
  const chars = [...text].length
  if (chars > X_CHAR_LIMIT) {
    hints.push(`Character count ${chars} exceeds ${X_CHAR_LIMIT}.`)
  }

  const checks: EntryChecks = { blocking }
  if (hints.length > 0) checks.hints = hints
  return { ok: true, checks }
}

export function characterCount(text: string): number {
  return [...text].length
}

export function costHint(text: string): string {
  const withUrl = /\bhttps?:\/\//i.test(text)
  if (withUrl) {
    return 'X pay-per-use: 0.200 USD (post contains a URL). A post without a URL is 0.015 USD.'
  }
  return 'X pay-per-use: 0.015 USD per post, 0.200 USD if the post contains a URL.'
}
