import { randomUUID } from 'node:crypto'
import { SYSTEM_ACTOR, writeAudit } from './audit'
import type { SqliteDatabase } from './db'
import type { Actor } from './entries'
import type { PublishResult } from './status'

export type ClaimedPost = {
  postId: string
  entryId: string
  bundleId: string
  text: string
  scheduledAt: number
  contentHash: string
  imageSha256: string | null
}

function immediate<T>(db: SqliteDatabase, fn: () => T): T {
  return db.transaction(fn).immediate()
}

export function claimNextDue(
  db: SqliteDatabase,
  now: number
): ClaimedPost | null {
  return immediate<ClaimedPost | null>(db, () => {
    const inFlight = db.prepare(
      `SELECT 1 FROM scheduled_posts WHERE status = 'in-flight' LIMIT 1`
    ).get()
    if (inFlight) {
      return null
    }
    const row = db.prepare(
      `SELECT p.id AS postId, e.id AS entryId, e.bundleId, e.text, e.scheduledAt,
              e.contentHash, e.imageSha256
       FROM scheduled_posts p JOIN entries e ON e.id = p.entryId
       WHERE p.status = 'pending' AND e.state = 'approved' AND e.scheduledAt <= ?
       ORDER BY e.scheduledAt ASC, p.createdAt ASC LIMIT 1`
    ).get(now) as ClaimedPost | undefined
    if (!row) {
      return null
    }
    const updated = db.prepare(
      `UPDATE scheduled_posts SET status = 'in-flight', startedAt = ?, updatedAt = ?
       WHERE id = ? AND status = 'pending'`
    ).run(now, now, row.postId)
    if (updated.changes !== 1) {
      return null
    }
    return row
  })
}

export type FinishResult =
  | { ok: true; status: 'sent' | 'failed' | 'uncertain' }
  | { ok: false; reason: 'conflict' }

export function finishPost(
  db: SqliteDatabase,
  input: {
    postId: string
    result: PublishResult
    now: number
  }
): FinishResult {
  const status = input.result.ok
    ? 'sent'
    : input.result.uncertain === true
      ? 'uncertain'
      : 'failed'
  return immediate<FinishResult>(db, () => {
    const post = db.prepare(
      'SELECT entryId FROM scheduled_posts WHERE id = ?'
    ).get(input.postId) as
      | { entryId: string }
      | undefined
    if (!post) {
      return { ok: false, reason: 'conflict' }
    }
    const updated = db.prepare(
      `UPDATE scheduled_posts SET status = ?, url = ?, updatedAt = ?
       WHERE id = ? AND status = 'in-flight'`
    ).run(
      status,
      status === 'sent' ? input.result.url ?? null : null,
      input.now,
      input.postId
    )
    if (updated.changes !== 1) {
      return { ok: false, reason: 'conflict' }
    }
    const entry = db.prepare(
      'SELECT bundleId FROM entries WHERE id = ?'
    ).get(post.entryId) as { bundleId: string }
    db.prepare(
      `INSERT INTO publish_results (id, scheduledPostId, at, ok, url, error, uncertain)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      randomUUID(),
      input.postId,
      input.now,
      input.result.ok ? 1 : 0,
      status === 'sent' ? input.result.url ?? null : null,
      input.result.error ?? null,
      input.result.uncertain === true ? 1 : 0
    )
    writeAudit(db, {
      at: input.now,
      event: 'published',
      bundleId: entry.bundleId,
      entryId: post.entryId,
      actorUser: SYSTEM_ACTOR.user,
      actorAccount: SYSTEM_ACTOR.account,
      reason: status
    })
    return { ok: true, status }
  })
}

export function markInterruptedOnBoot(db: SqliteDatabase, now: number): string[] {
  return immediate<string[]>(db, () => {
    const rows = db.prepare(
      `SELECT p.id AS postId, p.entryId, e.bundleId FROM scheduled_posts p
       JOIN entries e ON e.id = p.entryId WHERE p.status = 'in-flight'`
    ).all() as Array<{ postId: string; entryId: string; bundleId: string }>
    const interrupted: string[] = []
    for (const row of rows) {
      const updated = db.prepare(
        `UPDATE scheduled_posts SET status = 'uncertain', updatedAt = ?
         WHERE id = ? AND status = 'in-flight'`
      ).run(now, row.postId)
      if (updated.changes !== 1) {
        continue
      }
      interrupted.push(row.postId)
      db.prepare(
        `INSERT INTO publish_results (id, scheduledPostId, at, ok, url, error, uncertain)
         VALUES (?, ?, ?, 0, NULL, 'interrupted by restart', 1)`
      ).run(randomUUID(), row.postId, now)
      writeAudit(db, {
        at: now,
        event: 'interrupted',
        bundleId: row.bundleId,
        entryId: row.entryId,
        actorUser: SYSTEM_ACTOR.user,
        actorAccount: SYSTEM_ACTOR.account,
        reason: 'interrupted by restart'
      })
    }
    return interrupted
  })
}

export type QueueMutation =
  | { ok: true; status: 'pending' }
  | { ok: false; reason: 'conflict' }

export function retryPost(
  db: SqliteDatabase,
  input: {
    postId: string
    actor: Actor
    now: number
  }
): QueueMutation {
  return immediate<QueueMutation>(db, () => {
    const post = db.prepare(
      'SELECT entryId FROM scheduled_posts WHERE id = ?'
    ).get(input.postId) as { entryId: string } | undefined
    const updated = db.prepare(
      `UPDATE scheduled_posts SET status = 'pending', url = NULL, updatedAt = ?
       WHERE id = ? AND status = 'failed'`
    ).run(input.now, input.postId)
    if (updated.changes !== 1) {
      writeAudit(db, {
        at: input.now,
        event: 'refused',
        bundleId: null,
        entryId: post?.entryId ?? null,
        actorUser: input.actor.user,
        actorAccount: input.actor.account,
        reason: 'conflict'
      })
      return { ok: false, reason: 'conflict' }
    }
    const entry = db.prepare(
      'SELECT bundleId FROM entries WHERE id = ?'
    ).get(post!.entryId) as { bundleId: string }
    writeAudit(db, {
      at: input.now,
      event: 'retried',
      bundleId: entry.bundleId,
      entryId: post!.entryId,
      actorUser: input.actor.user,
      actorAccount: input.actor.account,
      reason: null
    })
    return { ok: true, status: 'pending' }
  })
}

export function resolveUncertain(
  db: SqliteDatabase,
  input: {
    postId: string
    resolution: 'sent' | 'failed'
    url?: string
    actor: Actor
    now: number
  }
): QueueMutation | { ok: true; status: 'sent' | 'failed' } {
  return immediate<QueueMutation | { ok: true; status: 'sent' | 'failed' }>(
    db,
    () => {
      const post = db.prepare(
        'SELECT entryId FROM scheduled_posts WHERE id = ?'
      ).get(input.postId) as { entryId: string } | undefined
      const updated = db.prepare(
        `UPDATE scheduled_posts SET status = ?, url = ?, updatedAt = ?
         WHERE id = ? AND status = 'uncertain'`
      ).run(
        input.resolution,
        input.resolution === 'sent' ? input.url ?? null : null,
        input.now,
        input.postId
      )
      if (updated.changes !== 1) {
        writeAudit(db, {
          at: input.now,
          event: 'refused',
          bundleId: null,
          entryId: post?.entryId ?? null,
          actorUser: input.actor.user,
          actorAccount: input.actor.account,
          reason: 'conflict'
        })
        return { ok: false, reason: 'conflict' }
      }
      const entry = db.prepare(
        'SELECT bundleId FROM entries WHERE id = ?'
      ).get(post!.entryId) as { bundleId: string }
      writeAudit(db, {
        at: input.now,
        event: 'resolved',
        bundleId: entry.bundleId,
        entryId: post!.entryId,
        actorUser: input.actor.user,
        actorAccount: input.actor.account,
        reason: input.resolution
      })
      return { ok: true, status: input.resolution }
    }
  )
}
