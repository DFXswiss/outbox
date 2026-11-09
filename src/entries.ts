import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { writeAudit } from './audit'
import { contentHash, imageSha256 } from './content-hash'
import type { SqliteDatabase } from './db'
import type { ChannelId, EntryState } from './status'

const QUEUE_CHANNEL: ChannelId = 'x'

export type Actor = {
  user: string
  account: string
}

/**
 * JSON stored in `entries.checks`. A missing column, unparseable text, or a
 * value without `blocking` is not a pass — `canDecide` rejects those.
 */
export const EntryChecksSchema = z.object({
  blocking: z.array(z.string()),
  hints: z.array(z.string()).optional()
})
export type EntryChecks = z.infer<typeof EntryChecksSchema>

export type SubmitInput = {
  text: string
  scheduledAt: number
  imageBytes?: Buffer | Uint8Array | null
  checks: EntryChecks | null
  actor: Actor
  now?: number
}

export type SubmitResult =
  | { ok: true; bundleId: string; entryId: string; contentHash: string }
  | { ok: false; reason: 'past-time' }

export type RetractInput = {
  bundleId: string
  actor: Actor
  now?: number
}

export type RetractResult = { ok: true } | { ok: false; reason: 'conflict' }

export type DecideInput = {
  entryId: string
  decision: 'approve' | 'reject'
  actor: Actor
  now?: number
  imageBytes?: Buffer | Uint8Array | null
}

export type DecideResult =
  | { ok: true; state: 'approved' | 'rejected' }
  | { ok: false; reason: 'conflict' }
  | { ok: false; reason: 'stale-content' }
  | { ok: false; reason: 'not-approvable'; detail: string }

type EntryRow = {
  id: string
  bundleId: string
  state: string
  text: string
  scheduledAt: number
  imageSha256: string | null
  contentHash: string
  checks: string | null
  decidedByUser: string | null
  decidedByAccount: string | null
  decidedAt: number | null
}

function clock(now: number | undefined): number {
  return now ?? Date.now()
}

function inImmediate<T>(db: SqliteDatabase, fn: () => T): T {
  return db.transaction(fn).immediate()
}

function isUniqueConstraint(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE'
  )
}

export function parseChecks(raw: string | null | undefined): EntryChecks | null {
  if (raw == null || raw === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const result = EntryChecksSchema.safeParse(parsed)
  return result.success ? result.data : null
}

/**
 * Gate on **approve** only. Returns null when the entry may be approved, or
 * one English sentence explaining why it is locked. Reject is never locked
 * here.
 */
export function canDecide(
  entry: { scheduledAt: number; checks: string | null },
  now: number
): string | null {
  if (entry.scheduledAt <= now) {
    return 'The scheduled time has already passed, so this entry cannot be approved.'
  }
  const checks = parseChecks(entry.checks)
  if (checks === null) {
    return 'No review check is recorded, so this entry cannot be approved.'
  }
  if (checks.blocking.length > 0) {
    return 'A blocking review finding is recorded, so this entry cannot be approved.'
  }
  return null
}

function imageBytesOrEmpty(
  imageBytes: Buffer | Uint8Array | null | undefined
): Buffer | Uint8Array | null {
  if (imageBytes == null || imageBytes.byteLength === 0) return null
  return imageBytes
}

export function submitSubmission(db: SqliteDatabase, input: SubmitInput): SubmitResult {
  const now = clock(input.now)
  const actor = input.actor

  return inImmediate(db, () => {
    if (input.scheduledAt <= now) {
      writeAudit(db, {
        at: now,
        event: 'refused',
        bundleId: null,
        entryId: null,
        actorUser: actor.user,
        actorAccount: actor.account,
        reason: 'past-time'
      })
      return { ok: false, reason: 'past-time' }
    }

    const bundleId = randomUUID()
    const entryId = randomUUID()
    const bytes = imageBytesOrEmpty(input.imageBytes)
    const hash = contentHash(input.text, input.scheduledAt, bytes)
    const checksJson = input.checks === null ? null : JSON.stringify(input.checks)

    db.prepare(
      `INSERT INTO bundles (id, createdAt, authoredByUser, authoredByAccount)
       VALUES (?, ?, ?, ?)`
    ).run(bundleId, now, actor.user, actor.account)

    db.prepare(
      `INSERT INTO entries (
         id, bundleId, state, text, scheduledAt, imageSha256, contentHash, checks,
         decidedByUser, decidedByAccount, decidedAt
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`
    ).run(
      entryId,
      bundleId,
      'submitted' satisfies EntryState,
      input.text,
      input.scheduledAt,
      bytes ? imageSha256(bytes) : null,
      hash,
      checksJson
    )

    writeAudit(db, {
      at: now,
      event: 'submitted',
      bundleId,
      entryId,
      actorUser: actor.user,
      actorAccount: actor.account,
      reason: null
    })

    return { ok: true, bundleId, entryId, contentHash: hash }
  })
}

class CompareAndSetLostError extends Error {
  override readonly name = 'CompareAndSetLostError'
}

export function retractBundle(db: SqliteDatabase, input: RetractInput): RetractResult {
  const now = clock(input.now)
  const actor = input.actor

  const refuseOutside = (entryId: string | null): RetractResult => {
    inImmediate(db, () => {
      writeAudit(db, {
        at: now,
        event: 'refused',
        bundleId: input.bundleId,
        entryId,
        actorUser: actor.user,
        actorAccount: actor.account,
        reason: 'conflict'
      })
    })
    return { ok: false, reason: 'conflict' }
  }

  try {
    return inImmediate(db, () => {
      const rows = db
        .prepare('SELECT id, state FROM entries WHERE bundleId = ?')
        .all(input.bundleId) as Array<{ id: string; state: string }>

      const refuse = (): RetractResult => {
        writeAudit(db, {
          at: now,
          event: 'refused',
          bundleId: input.bundleId,
          entryId: rows[0]?.id ?? null,
          actorUser: actor.user,
          actorAccount: actor.account,
          reason: 'conflict'
        })
        return { ok: false, reason: 'conflict' }
      }

      if (rows.length === 0) return refuse()
      if (rows.some((row) => row.state !== 'submitted')) return refuse()

      const updated = db
        .prepare(
          `UPDATE entries SET state = ?
           WHERE bundleId = ? AND state = ?`
        )
        .run('retracted' satisfies EntryState, input.bundleId, 'submitted' satisfies EntryState)

      // A short write would retract only some entries; abort the whole bundle.
      if (updated.changes !== rows.length) throw new CompareAndSetLostError()

      writeAudit(db, {
        at: now,
        event: 'retracted',
        bundleId: input.bundleId,
        entryId: rows.length === 1 ? rows[0]!.id : null,
        actorUser: actor.user,
        actorAccount: actor.account,
        reason: null
      })
      return { ok: true }
    })
  } catch (err) {
    if (!(err instanceof CompareAndSetLostError)) throw err
    return refuseOutside(null)
  }
}

export function decideEntry(db: SqliteDatabase, input: DecideInput): DecideResult {
  const now = clock(input.now)
  const actor = input.actor

  const run = (): DecideResult =>
    inImmediate(db, () => {
      const entry = db
        .prepare('SELECT * FROM entries WHERE id = ?')
        .get(input.entryId) as EntryRow | undefined

      const refuseConflict = (): DecideResult => {
        writeAudit(db, {
          at: now,
          event: 'refused',
          bundleId: entry?.bundleId ?? null,
          entryId: input.entryId,
          actorUser: actor.user,
          actorAccount: actor.account,
          reason: 'conflict'
        })
        return { ok: false, reason: 'conflict' }
      }

      if (!entry) return refuseConflict()
      if (entry.state !== 'submitted') return refuseConflict()

      if (input.decision === 'approve') {
        const lock = canDecide({ scheduledAt: entry.scheduledAt, checks: entry.checks }, now)
        if (lock !== null) {
          writeAudit(db, {
            at: now,
            event: 'refused',
            bundleId: entry.bundleId,
            entryId: input.entryId,
            actorUser: actor.user,
            actorAccount: actor.account,
            reason: lock
          })
          return { ok: false, reason: 'not-approvable', detail: lock }
        }

        const recomputed = contentHash(
          entry.text,
          entry.scheduledAt,
          imageBytesOrEmpty(input.imageBytes)
        )
        if (recomputed !== entry.contentHash) {
          writeAudit(db, {
            at: now,
            event: 'refused',
            bundleId: entry.bundleId,
            entryId: input.entryId,
            actorUser: actor.user,
            actorAccount: actor.account,
            reason: 'stale-content'
          })
          return { ok: false, reason: 'stale-content' }
        }
      }

      const nextState: EntryState = input.decision === 'approve' ? 'approved' : 'rejected'
      const updated = db
        .prepare(
          `UPDATE entries
           SET state = ?, decidedByUser = ?, decidedByAccount = ?, decidedAt = ?
           WHERE id = ? AND state = ?`
        )
        .run(nextState, actor.user, actor.account, now, input.entryId, 'submitted' satisfies EntryState)

      if (updated.changes !== 1) return refuseConflict()

      if (input.decision === 'approve') {
        const author = db
          .prepare('SELECT authoredByUser, authoredByAccount FROM bundles WHERE id = ?')
          .get(entry.bundleId) as { authoredByUser: string; authoredByAccount: string }
        db.prepare(
          `INSERT INTO scheduled_posts (
             id, entryId, channel, status, createdAt, updatedAt,
             authoredByUser, authoredByAccount
           ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`
        ).run(
          randomUUID(),
          input.entryId,
          QUEUE_CHANNEL,
          now,
          now,
          author.authoredByUser,
          author.authoredByAccount
        )
      }

      writeAudit(db, {
        at: now,
        event: 'decided',
        bundleId: entry.bundleId,
        entryId: input.entryId,
        actorUser: actor.user,
        actorAccount: actor.account,
        reason: input.decision
      })

      return { ok: true, state: nextState }
    })

  try {
    return run()
  } catch (err) {
    if (!isUniqueConstraint(err)) throw err
    inImmediate(db, () => {
      writeAudit(db, {
        at: now,
        event: 'refused',
        bundleId: null,
        entryId: input.entryId,
        actorUser: actor.user,
        actorAccount: actor.account,
        reason: 'conflict'
      })
    })
    return { ok: false, reason: 'conflict' }
  }
}
