/**
 * Portable campaign-copy review engine. Pure Node/TypeScript — no Electron
 * or React imports — so tests and a later free-text reviewer can share the
 * same functions.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TopicRulesSchema, type TopicRules } from './schema'

export type { TopicRules }

export type EntryLike = {
  id: string
  postText: string
  templateParams: Record<string, unknown>
}

export function loadTopicRules(repoRoot: string, topic: string): TopicRules | null {
  const rulesPath = join(repoRoot, 'content', topic, 'rules.json')
  if (!existsSync(rulesPath)) return null
  return TopicRulesSchema.parse(JSON.parse(readFileSync(rulesPath, 'utf-8')))
}

function compile(sources: string[]): RegExp[] {
  return sources.map((source) => new RegExp(source, 'i'))
}

function cardText(entry: EntryLike): string {
  return JSON.stringify(entry.templateParams)
}

/**
 * A finding names the wording it tripped over, not just the entry it was in.
 * A reviewer who reads "flagged: draft" has to guess which sentence is meant;
 * one who reads `never holds` can fix it or reject it on the spot.
 */
export interface RuleHit {
  entryId: string
  /** The text the pattern actually matched, as it stands in the draft. */
  match: string
}

function firstMatch(patterns: RegExp[], haystacks: string[]): string | null {
  for (const pattern of patterns) {
    for (const haystack of haystacks) {
      const found = pattern.exec(haystack)
      if (found) return found[0]
    }
  }
  return null
}

export function checkForbiddenClaims(entries: EntryLike[], rules: TopicRules): RuleHit[] {
  const patterns = compile(rules.forbiddenClaims)
  const findings: RuleHit[] = []
  for (const entry of entries) {
    const match = firstMatch(patterns, [entry.postText, cardText(entry)])
    if (match !== null) findings.push({ entryId: entry.id, match })
  }
  return findings
}

export function checkProvisionalQualifier(
  entries: EntryLike[],
  rules: TopicRules
): { missing: string[]; parameterEntryCount: number } {
  const patterns = compile(rules.provisionalParameters)
  const missing: string[] = []
  let parameterEntryCount = 0
  for (const entry of entries) {
    const combined = `${entry.postText}\n${cardText(entry)}`
    if (!patterns.some((pattern) => pattern.test(combined))) continue
    parameterEntryCount += 1
    if (!/provisional/i.test(combined)) missing.push(entry.id)
  }
  return { missing, parameterEntryCount }
}

export function checkEmojiCount(entries: EntryLike[], maxEmoji = 3): string[] {
  const findings: string[] = []
  for (const entry of entries) {
    const count = entry.postText.match(/\p{Extended_Pictographic}/gu)?.length ?? 0
    if (count > maxEmoji) findings.push(entry.id)
  }
  return findings
}

export function checkSentenceLength(entries: EntryLike[], maxWords = 35): string[] {
  const findings: string[] = []
  for (const entry of entries) {
    const tooLong = entry.postText.split(/\. |! |\? /).some((sentence) => {
      const words = sentence.trim().split(/\s+/).filter(Boolean)
      return words.length > maxWords
    })
    if (tooLong) findings.push(entry.id)
  }
  return findings
}

export function checkMicarUnsafe(entries: EntryLike[], rules: TopicRules): RuleHit[] {
  if (rules.micarUnsafe.length === 0) return []
  const patterns = compile(rules.micarUnsafe)
  const findings: RuleHit[] = []
  for (const entry of entries) {
    const match = firstMatch(patterns, [entry.postText, cardText(entry)])
    if (match !== null) findings.push({ entryId: entry.id, match })
  }
  return findings
}
