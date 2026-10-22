import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type SqliteDatabase } from './db'
import { decideEntry, submitSubmission } from './entries'
import {
  claimNextDue,
  finishPost,
  markInterruptedOnBoot,
  resolveUncertain,
  retryPost
} from './queue'

const NOW = 1_700_000_000_000
const SETUP_NOW = NOW - 60_000
const ACTOR = { user: 'author', account: 'account' }
const ADMIN = { user: 'admin', account: 'admin-account' }
let dir: string
let db: SqliteDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'outbox-queue-'))
  db = openDatabase(join(dir, 'db.sqlite'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function approved(scheduledAt = NOW + 1) {
  const submitted = submitSubmission(db, {
    text: 'approved copy',
    scheduledAt,
    checks: { blocking: [] },
    actor: ACTOR,
    now: SETUP_NOW
  })
  if (!submitted.ok) {
    throw new Error('submission failed')
  }
  const decision = decideEntry(db, {
    entryId: submitted.entryId,
    decision: 'approve',
    actor: ADMIN,
    now: SETUP_NOW
  })
  if (!decision.ok) {
    throw new Error('approval failed')
  }
  return db.prepare(
    'SELECT id FROM scheduled_posts WHERE entryId = ?'
  ).get(submitted.entryId) as { id: string }
}

describe('serial queue state transitions', () => {
  it('does not claim posts that are not due, terminal, or unapproved', () => {
    const later = approved(NOW + 1)
    const failed = approved(NOW)
    const uncertain = approved(NOW)
    const sent = approved(NOW)
    const unapproved = approved(NOW)
    db.prepare("UPDATE scheduled_posts SET status = 'failed' WHERE id = ?").run(failed.id)
    db.prepare("UPDATE scheduled_posts SET status = 'uncertain' WHERE id = ?").run(uncertain.id)
    db.prepare("UPDATE scheduled_posts SET status = 'sent' WHERE id = ?").run(sent.id)
    const unapprovedEntry = (
      db.prepare('SELECT entryId FROM scheduled_posts WHERE id = ?')
        .get(unapproved.id) as { entryId: string }
    ).entryId
    db.prepare("UPDATE entries SET state = 'submitted' WHERE id = ?").run(unapprovedEntry)
    expect(claimNextDue(db, NOW)).toBeNull()
    expect(
      db.prepare(
        "SELECT COUNT(*) AS n FROM scheduled_posts WHERE status = 'in-flight'"
      ).get()
    ).toEqual({ n: 0 })
    expect(
      (db.prepare('SELECT status FROM scheduled_posts WHERE id = ?')
        .get(later.id) as { status: string }).status
    ).toBe('pending')
    expect(
      db.prepare('SELECT status FROM scheduled_posts WHERE id = ?').get(failed.id)
    ).toEqual({ status: 'failed' })
  })

  it('does not claim a second post until the in-flight post finishes', () => {
    const firstPost = approved(NOW)
    const secondPost = approved(NOW)
    const firstClaim = claimNextDue(db, NOW)

    expect(firstClaim).not.toBeNull()
    expect([firstPost.id, secondPost.id]).toContain(firstClaim!.postId)
    expect(claimNextDue(db, NOW)).toBeNull()

    finishPost(db, {
      postId: firstClaim!.postId,
      result: { channel: 'x', ok: false, error: 'HTTP 400' },
      now: NOW + 1
    })

    const secondClaim = claimNextDue(db, NOW + 1)
    const expectedId = firstClaim!.postId === firstPost.id
      ? secondPost.id
      : firstPost.id
    expect(secondClaim?.postId).toBe(expectedId)
  })

  it.each([
    {
      result: {
        channel: 'x' as const,
        ok: true,
        url: 'https://x.com/test/status/1'
      },
      status: 'sent'
    },
    {
      result: { channel: 'x' as const, ok: false, error: 'HTTP 400' },
      status: 'failed'
    },
    {
      result: {
        channel: 'x' as const,
        ok: false,
        uncertain: true,
        error: 'HTTP 500'
      },
      status: 'uncertain'
    }
  ])(
    'records $status from the publisher result and only finishes in-flight rows',
    ({ result, status }) => {
      const post = approved(NOW)
      claimNextDue(db, NOW)
      expect(finishPost(db, {
        postId: post.id,
        result,
        now: NOW + 1
      })).toEqual({ ok: true, status })
      expect(
        (db.prepare('SELECT status FROM scheduled_posts WHERE id = ?')
          .get(post.id) as { status: string }).status
      ).toBe(status)
      expect(
        (db.prepare(
          'SELECT COUNT(*) AS n FROM publish_results WHERE scheduledPostId = ?'
        ).get(post.id) as { n: number }).n
      ).toBe(1)
      expect(db.prepare(
        'SELECT ok, url, uncertain FROM publish_results WHERE scheduledPostId = ?'
      ).get(post.id)).toEqual(status === 'sent'
        ? { ok: 1, url: 'https://x.com/test/status/1', uncertain: 0 }
        : status === 'uncertain'
          ? { ok: 0, url: null, uncertain: 1 }
          : { ok: 0, url: null, uncertain: 0 })
      expect(db.prepare(
        `SELECT reason FROM audit WHERE event = 'published'
         AND entryId = (SELECT entryId FROM scheduled_posts WHERE id = ?)`
      ).get(post.id)).toEqual({ reason: status })
      expect(finishPost(db, {
        postId: post.id,
        result,
        now: NOW + 2
      })).toEqual({ ok: false, reason: 'conflict' })
      const pending = approved(NOW)
      expect(finishPost(db, {
        postId: pending.id,
        result,
        now: NOW + 2
      })).toEqual({ ok: false, reason: 'conflict' })
      expect(
        db.prepare('SELECT status FROM scheduled_posts WHERE id = ?')
          .get(pending.id)
      ).toEqual({ status: 'pending' })
      expect(
        db.prepare(
          'SELECT COUNT(*) AS n FROM publish_results WHERE scheduledPostId = ?'
        ).get(pending.id)
      ).toEqual({ n: 0 })
      if (status === 'sent') {
        expect(retryPost(db, {
          postId: post.id,
          actor: ADMIN,
          now: NOW + 2
        })).toEqual({ ok: false, reason: 'conflict' })
      }
    }
  )

  it('allows retry only from failed and resolution only from uncertain', () => {
    const failed = approved(NOW)
    claimNextDue(db, NOW)
    finishPost(db, {
      postId: failed.id,
      result: { channel: 'x', ok: false, error: 'bad request' },
      now: NOW
    })
    expect(resolveUncertain(db, {
      postId: failed.id,
      resolution: 'sent',
      actor: ADMIN,
      now: NOW + 1
    })).toEqual({ ok: false, reason: 'conflict' })
    expect(
      db.prepare('SELECT status FROM scheduled_posts WHERE id = ?').get(failed.id)
    ).toEqual({ status: 'failed' })
    expect(retryPost(db, {
      postId: failed.id,
      actor: ADMIN,
      now: NOW + 1
    })).toEqual({ ok: true, status: 'pending' })
    expect(retryPost(db, {
      postId: failed.id,
      actor: ADMIN,
      now: NOW + 2
    })).toEqual({ ok: false, reason: 'conflict' })
    expect(resolveUncertain(db, {
      postId: failed.id,
      resolution: 'sent',
      actor: ADMIN,
      now: NOW + 2
    })).toEqual({ ok: false, reason: 'conflict' })
    expect(
      db.prepare('SELECT status FROM scheduled_posts WHERE id = ?').get(failed.id)
    ).toEqual({ status: 'pending' })
    db.prepare("UPDATE scheduled_posts SET status = 'sent' WHERE id = ?").run(failed.id)
    expect(retryPost(db, {
      postId: failed.id,
      actor: ADMIN,
      now: NOW + 3
    })).toEqual({ ok: false, reason: 'conflict' })
    expect(
      db.prepare('SELECT status FROM scheduled_posts WHERE id = ?').get(failed.id)
    ).toEqual({ status: 'sent' })

    const uncertain = approved(NOW)
    claimNextDue(db, NOW)
    finishPost(db, {
      postId: uncertain.id,
      result: { channel: 'x', ok: false, uncertain: true },
      now: NOW
    })
    expect(retryPost(db, {
      postId: uncertain.id,
      actor: ADMIN,
      now: NOW + 1
    })).toEqual({ ok: false, reason: 'conflict' })
    expect(resolveUncertain(db, {
      postId: uncertain.id,
      resolution: 'sent',
      url: 'https://x.com/test/status/2',
      actor: ADMIN,
      now: NOW + 1
    })).toEqual({ ok: true, status: 'sent' })
    expect(resolveUncertain(db, {
      postId: uncertain.id,
      resolution: 'failed',
      actor: ADMIN,
      now: NOW + 2
    })).toEqual({ ok: false, reason: 'conflict' })
  })

  it('refuses retry and either resolution while a post is in-flight', () => {
    const post = approved(NOW)
    expect(claimNextDue(db, NOW)?.postId).toBe(post.id)

    expect(retryPost(db, {
      postId: post.id,
      actor: ADMIN,
      now: NOW + 1
    })).toEqual({ ok: false, reason: 'conflict' })
    for (const resolution of ['sent', 'failed'] as const) {
      expect(resolveUncertain(db, {
        postId: post.id,
        resolution,
        actor: ADMIN,
        now: NOW + 1
      })).toEqual({ ok: false, reason: 'conflict' })
    }

    expect(
      db.prepare('SELECT status FROM scheduled_posts WHERE id = ?').get(post.id)
    ).toEqual({ status: 'in-flight' })
    expect(
      db.prepare(
        'SELECT COUNT(*) AS n FROM publish_results WHERE scheduledPostId = ?'
      ).get(post.id)
    ).toEqual({ n: 0 })
  })

  it('marks every in-flight row uncertain at boot and audits the interruption', () => {
    const posts = [approved(NOW), approved(NOW)]
    const markInFlight = db.prepare(
      "UPDATE scheduled_posts SET status = 'in-flight' WHERE id = ?"
    )
    for (const post of posts) {
      markInFlight.run(post.id)
    }

    expect(markInterruptedOnBoot(db, NOW + 1).sort())
      .toEqual(posts.map((post) => post.id).sort())
    for (const post of posts) {
      expect(
        db.prepare('SELECT status FROM scheduled_posts WHERE id = ?').get(post.id)
      ).toEqual({ status: 'uncertain' })
    }
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM audit WHERE event = 'interrupted'").get()
    ).toEqual({ n: 2 })
  })
})
