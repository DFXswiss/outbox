import {
  checkForbiddenClaims,
  checkMicarUnsafe,
  checkProvisionalQualifier,
  loadTopicRules,
  type TopicRules
} from '../review/engine'
import type { EntryChecks } from './entries'

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

/** Checks deterministic blocking wording rules; factual truth is outside this review. */
export function reviewText(packRoot: string, brand: string, text: string): ReviewRun {
  const rules = loadPackRules(packRoot, brand)
  if (rules === null) return { ok: false, reason: 'missing-pack' }

  const entries = [{ id: 'draft', postText: text, templateParams: {} }]
  const blocking: string[] = []
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
  const checks: EntryChecks = { blocking }
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
