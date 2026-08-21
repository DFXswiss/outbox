import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type SqliteDatabase } from './db'
import {
  canDecide,
  decideEntry,
  retractBundle,
  submitSubmission,
  type Actor,
  type EntryChecks
} from './entries'

const NOW = 1_700_000_000_000
const FUTURE = NOW + 60_000
const PAST = NOW - 1
const ACTOR: Actor = { user: 'user-1', account: 'account-1' }
const APPROVER: Actor = { user: 'user-2', account: 'account-2' }
const PASSED: EntryChecks = { blocking: [] }

let dir: string
let db: SqliteDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'outbox-state-'))
  db = openDatabase(join(dir, 'state.sqlite'))
})

afterEach(() => {
  try {
    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

function submit(overrides: Partial<Parameters<typeof submitSubmission>[1]> = {}) {
  return submitSubmission(db, {
    text: 'Hello from the queue',
    scheduledAt: FUTURE,
    checks: PASSED,
    actor: ACTOR,
    now: NOW,
    ...overrides
  })
}

function entryState(entryId: string): string {
  const row = db.prepare('SELECT state FROM entries WHERE id = ?').get(entryId) as
    | { state: string }
    | undefined
  return row?.state ?? ''
}

function queueFor(entryId: string): Array<{ channel: string; status: string }> {
  return db
    .prepare('SELECT channel, status FROM scheduled_posts WHERE entryId = ?')
    .all(entryId) as Array<{ channel: string; status: string }>
}

function auditEvents(): Array<{ event: string; reason: string | null; entryId: string | null }> {
  return db
    .prepare('SELECT event, reason, entryId FROM audit ORDER BY at ASC, id ASC')
    .all() as Array<{ event: string; reason: string | null; entryId: string | null }>
}

describe('submitSubmission', () => {
  it('rejects a scheduled time that is already past and writes nothing', () => {
    const result = submit({ scheduledAt: PAST })
    expect(result).toEqual({ ok: false, reason: 'past-time' })
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM bundles').get() as { n: number }).n
    ).toBe(0)
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM entries').get() as { n: number }).n
    ).toBe(0)
  })

  it('opens the same file a second time without dropping existing rows', () => {
    const created = submit()
    expect(created.ok).toBe(true)
    db.close()
    db = openDatabase(join(dir, 'state.sqlite'))
    if (!created.ok) throw new Error('expected submit to succeed')
    expect(entryState(created.entryId)).toBe('submitted')
  })
})

describe('approve and the send queue', () => {
  it('approve inserts exactly one pending x row; a second approve inserts none', () => {
    const created = submit()
    if (!created.ok) throw new Error('expected submit to succeed')

    const first = decideEntry(db, {
      entryId: created.entryId,
      decision: 'approve',
      actor: APPROVER,
      now: NOW
    })
    expect(first).toEqual({ ok: true, state: 'approved' })
    expect(queueFor(created.entryId)).toEqual([{ channel: 'x', status: 'pending' }])

    const second = decideEntry(db, {
      entryId: created.entryId,
      decision: 'approve',
      actor: APPROVER,
      now: NOW
    })
    expect(second).toEqual({ ok: false, reason: 'conflict' })
    expect(queueFor(created.entryId)).toHaveLength(1)
    expect(entryState(created.entryId)).toBe('approved')
  })

  it('reject does not insert a queue row', () => {
    const created = submit()
    if (!created.ok) throw new Error('expected submit to succeed')

    const result = decideEntry(db, {
      entryId: created.entryId,
      decision: 'reject',
      actor: APPROVER,
      now: NOW
    })
    expect(result).toEqual({ ok: true, state: 'rejected' })
    expect(queueFor(created.entryId)).toEqual([])
    expect(entryState(created.entryId)).toBe('rejected')
  })
})

describe('retract versus decide — one winner', () => {
  it('retract after a decision fails, and a decision after a retract fails', () => {
    const approved = submit()
    if (!approved.ok) throw new Error('expected submit to succeed')
    expect(
      decideEntry(db, {
        entryId: approved.entryId,
        decision: 'approve',
        actor: APPROVER,
        now: NOW
      }).ok
    ).toBe(true)
    expect(
      retractBundle(db, { bundleId: approved.bundleId, actor: ACTOR, now: NOW })
    ).toEqual({ ok: false, reason: 'conflict' })
    expect(entryState(approved.entryId)).toBe('approved')

    const retracted = submit()
    if (!retracted.ok) throw new Error('expected submit to succeed')
    expect(
      retractBundle(db, { bundleId: retracted.bundleId, actor: ACTOR, now: NOW })
    ).toEqual({ ok: true })
    expect(entryState(retracted.entryId)).toBe('retracted')
    expect(
      decideEntry(db, {
        entryId: retracted.entryId,
        decision: 'approve',
        actor: APPROVER,
        now: NOW
      })
    ).toEqual({ ok: false, reason: 'conflict' })
    expect(queueFor(retracted.entryId)).toEqual([])
  })
})

describe('canDecide locks', () => {
  it('a passed scheduled time blocks approve and still allows reject', () => {
    const created = submit({ scheduledAt: FUTURE, now: NOW })
    if (!created.ok) throw new Error('expected submit to succeed')

    const lateApprove = decideEntry(db, {
      entryId: created.entryId,
      decision: 'approve',
      actor: APPROVER,
      now: FUTURE
    })
    expect(lateApprove.ok).toBe(false)
    if (lateApprove.ok || lateApprove.reason !== 'not-approvable') {
      throw new Error('expected a not-approvable result')
    }
    expect(lateApprove.detail).toBe(
      'The scheduled time has already passed, so this entry cannot be approved.'
    )
    expect(queueFor(created.entryId)).toEqual([])
    expect(entryState(created.entryId)).toBe('submitted')

    const lateReject = decideEntry(db, {
      entryId: created.entryId,
      decision: 'reject',
      actor: APPROVER,
      now: FUTURE
    })
    expect(lateReject).toEqual({ ok: true, state: 'rejected' })
    expect(queueFor(created.entryId)).toEqual([])
  })

  it('a blocking finding blocks approve; missing checks block approve the same way', () => {
    const blocked = submit({
      checks: { blocking: ['forbidden claim: trustless'] }
    })
    if (!blocked.ok) throw new Error('expected submit to succeed')
    const blockedApprove = decideEntry(db, {
      entryId: blocked.entryId,
      decision: 'approve',
      actor: APPROVER,
      now: NOW
    })
    expect(blockedApprove.ok).toBe(false)
    if (blockedApprove.ok || blockedApprove.reason !== 'not-approvable') {
      throw new Error('expected a not-approvable result')
    }
    expect(blockedApprove.detail).toBe(
      'A blocking review finding is recorded, so this entry cannot be approved.'
    )
    expect(queueFor(blocked.entryId)).toEqual([])
    expect(entryState(blocked.entryId)).toBe('submitted')

    const unchecked = submit({ checks: null })
    if (!unchecked.ok) throw new Error('expected submit to succeed')
    const missingApprove = decideEntry(db, {
      entryId: unchecked.entryId,
      decision: 'approve',
      actor: APPROVER,
      now: NOW
    })
    expect(missingApprove.ok).toBe(false)
    if (missingApprove.ok || missingApprove.reason !== 'not-approvable') {
      throw new Error('expected a not-approvable result')
    }
    expect(missingApprove.detail).toBe(
      'No review check is recorded, so this entry cannot be approved.'
    )
    expect(canDecide({ scheduledAt: FUTURE, checks: null }, NOW)).toBe(
      'No review check is recorded, so this entry cannot be approved.'
    )
    expect(queueFor(unchecked.entryId)).toEqual([])

    const rejected = decideEntry(db, {
      entryId: unchecked.entryId,
      decision: 'reject',
      actor: APPROVER,
      now: NOW
    })
    expect(rejected).toEqual({ ok: true, state: 'rejected' })
  })
})

describe('stale content before the queue insert', () => {
  it('a changed body after submit prevents the queue row and leaves the entry submitted', () => {
    const created = submit()
    if (!created.ok) throw new Error('expected submit to succeed')

    db.prepare('UPDATE entries SET text = ? WHERE id = ?').run(
      'tampered body',
      created.entryId
    )

    const result = decideEntry(db, {
      entryId: created.entryId,
      decision: 'approve',
      actor: APPROVER,
      now: NOW
    })
    expect(result).toEqual({ ok: false, reason: 'stale-content' })
    expect(queueFor(created.entryId)).toEqual([])
    expect(entryState(created.entryId)).toBe('submitted')
  })
})

describe('scheduled_posts unique (entryId, channel)', () => {
  it('rejects a second row for the same entry and channel', () => {
    const created = submit()
    if (!created.ok) throw new Error('expected submit to succeed')

    db.prepare(
      `INSERT INTO scheduled_posts (id, entryId, channel, status, createdAt, updatedAt)
       VALUES (?, ?, 'x', 'pending', ?, ?)`
    ).run('post-1', created.entryId, NOW, NOW)

    let caught: unknown
    try {
      db.prepare(
        `INSERT INTO scheduled_posts (id, entryId, channel, status, createdAt, updatedAt)
         VALUES (?, ?, 'x', 'pending', ?, ?)`
      ).run('post-2', created.entryId, NOW, NOW)
    } catch (err) {
      caught = err
    }
    expect(caught).toMatchObject({ code: 'SQLITE_CONSTRAINT_UNIQUE' })
    expect(queueFor(created.entryId)).toHaveLength(1)
  })
})

describe('refused attempts are audited', () => {
  it('writes a refused audit row when approve is locked', () => {
    const created = submit({ checks: null })
    if (!created.ok) throw new Error('expected submit to succeed')

    decideEntry(db, {
      entryId: created.entryId,
      decision: 'approve',
      actor: APPROVER,
      now: NOW
    })

    const refused = auditEvents().filter((row) => row.event === 'refused')
    expect(refused).toHaveLength(1)
    expect(refused[0]?.entryId).toBe(created.entryId)
    expect(refused[0]?.reason).toBe(
      'No review check is recorded, so this entry cannot be approved.'
    )
  })
})
