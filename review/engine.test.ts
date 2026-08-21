import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  checkEmojiCount,
  checkForbiddenClaims,
  checkMicarUnsafe,
  checkProvisionalQualifier,
  checkSentenceLength,
  loadTopicRules,
  type EntryLike,
  type TopicRules
} from './engine'
import { TopicRulesSchema } from './schema'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

function entry(
  id: string,
  postText: string,
  templateParams: Record<string, unknown> = {}
): EntryLike {
  return { id, postText, templateParams }
}

function rules(overrides: Partial<TopicRules> = {}): TopicRules {
  return TopicRulesSchema.parse({
    topic: 'fixture',
    forbiddenClaims: [],
    ...overrides
  })
}

describe('loadTopicRules', () => {
  it('returns parsed rules when content/<topic>/rules.json exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'outbox-rules-'))
    try {
      const topic = 'fixture-topic'
      mkdirSync(join(root, 'content', topic), { recursive: true })
      writeFileSync(
        join(root, 'content', topic, 'rules.json'),
        JSON.stringify({ topic, forbiddenClaims: ['\\btrustless\\b'] })
      )
      const loaded = loadTopicRules(root, topic)
      expect(loaded).not.toBeNull()
      expect(loaded?.topic).toBe(topic)
      expect(loaded?.forbiddenClaims).toEqual(['\\btrustless\\b'])
      expect(loaded?.maxEmoji).toBe(3)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('returns null when the topic has no rules file', () => {
    expect(loadTopicRules(repoRoot, 'no-such-topic')).toBeNull()
  })
})

describe('TopicRulesSchema defaults', () => {
  it('fills optional lists and maxEmoji when omitted', () => {
    expect(TopicRulesSchema.parse({ topic: 'x', forbiddenClaims: ['a'] })).toEqual({
      topic: 'x',
      forbiddenClaims: ['a'],
      provisionalParameters: [],
      micarUnsafe: [],
      maxEmoji: 3
    })
  })
})

describe('checkForbiddenClaims', () => {
  const topicRules = rules({ forbiddenClaims: ['\\btrustless\\b', '\\bfully backed\\b'] })

  it('flags a post-text hit and a card-param hit', () => {
    expect(
      checkForbiddenClaims(
        [
          entry('hit-post', 'This design is trustless under the right assumptions.'),
          entry('hit-card', 'The specification defines a design.', { tag: 'Fully backed' }),
          entry('clean', 'The specification defines a design, not a live product.')
        ],
        topicRules
      )
    ).toEqual([
      // Das Finding traegt die getroffene Formulierung, nicht nur die Eintrags-Id.
      { entryId: 'hit-post', match: 'trustless' },
      { entryId: 'hit-card', match: 'Fully backed' }
    ])
  })

  it('does not flag a near-miss that the pattern does not cover', () => {
    expect(
      checkForbiddenClaims([entry('near', 'The design reduces trusted parties.')], topicRules)
    ).toEqual([])
  })
})

describe('checkProvisionalQualifier', () => {
  const topicRules = rules({ provisionalParameters: ['\\b2016\\b'] })

  it('accepts a parameter qualified as provisional in the same sentence', () => {
    expect(
      checkProvisionalQualifier(
        [entry('qualified', 'The provisional confirmation depth is 2016 blocks.')],
        topicRules
      )
    ).toEqual({ missing: [], parameterEntryCount: 1 })
  })

  it('flags a parameter when provisional appears only in another sentence', () => {
    expect(
      checkProvisionalQualifier(
        [entry('unqualified', 'The confirmation depth is 2016 blocks. Fees remain provisional.')],
        topicRules
      )
    ).toEqual({ missing: ['unqualified'], parameterEntryCount: 1 })
  })

  it('flags two occurrences when only one is qualified in its sentence', () => {
    expect(
      checkProvisionalQualifier(
        [
          entry(
            'partly-qualified',
            'The provisional confirmation depth is 2016 blocks. Settlement waits for 2016 blocks.'
          )
        ],
        topicRules
      )
    ).toEqual({ missing: ['partly-qualified'], parameterEntryCount: 1 })
  })

  it('flags a parameter without the qualifier in post text or card params', () => {
    expect(
      checkProvisionalQualifier(
        [
          entry('miss-post', 'The mint waits for 2016 blocks before settling.'),
          entry('miss-card', 'Confirmation depth is an economic choice.', {
            note: 'depth 2016 blocks'
          }),
          entry('ok', 'The mint waits for 2016 blocks (provisional) before settling.'),
          entry('clean', 'Confirmation depth is an economic choice under the design.')
        ],
        topicRules
      )
    ).toEqual({ missing: ['miss-post', 'miss-card'], parameterEntryCount: 3 })
  })

  it('does not flag a number that is not in the parameter list', () => {
    expect(
      checkProvisionalQualifier([entry('other', 'The mint waits for 12 blocks.')], topicRules)
    ).toEqual({ missing: [], parameterEntryCount: 0 })
  })
})

describe('checkEmojiCount', () => {
  it('flags a post that exceeds the limit', () => {
    expect(checkEmojiCount([entry('over', 'Hello 😀🎉🚀✨ world')], 3)).toEqual(['over'])
  })

  it('does not flag a post at the limit, or emoji only in card params', () => {
    expect(
      checkEmojiCount(
        [
          entry('at-limit', 'Hello 😀🎉🚀 world'),
          entry('card-only', 'Plain text', { tag: '😀🎉🚀✨' })
        ],
        3
      )
    ).toEqual([])
  })
})

describe('checkSentenceLength', () => {
  const long =
    'This sentence is deliberately padded with extra ordinary words so the word count climbs past the thirty-five word budget used by the plain-language heuristic and the check must flag this extra padded example sentence right now.'
  const short = 'This sentence stays well under the thirty-five word budget.'

  it('flags a sentence above the word budget', () => {
    expect(long.trim().split(/\s+/).length).toBeGreaterThan(35)
    expect(checkSentenceLength([entry('long', long)], 35)).toEqual(['long'])
  })

  it('does not flag a short sentence or a card-only long string', () => {
    expect(short.trim().split(/\s+/).length).toBeLessThanOrEqual(35)
    expect(checkSentenceLength([entry('short', short, { note: long })], 35)).toEqual([])
  })
})

describe('checkMicarUnsafe', () => {
  const topicRules = rules({ micarUnsafe: ['\\bsecurity token\\b', '\\be-money\\b'] })

  it('flags a listed phrase in post text or card params', () => {
    expect(
      checkMicarUnsafe(
        [
          entry('hit-post', 'This product is a security token under MiCAR.'),
          entry('hit-card', 'A factual product description.', { tag: 'e-money' }),
          entry('clean', 'This product is a crypto-asset described in the whitepaper.')
        ],
        topicRules
      )
    ).toEqual([
      { entryId: 'hit-post', match: 'security token' },
      { entryId: 'hit-card', match: 'e-money' }
    ])
  })

  it('does not run when the topic list is empty, even if the text would match', () => {
    expect(
      checkMicarUnsafe(
        [entry('ignored', 'This product is a security token under MiCAR.')],
        rules({ micarUnsafe: [] })
      )
    ).toEqual([])
  })
})
