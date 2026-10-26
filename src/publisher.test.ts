import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Alert } from './alerts'
import { openDatabase, type SqliteDatabase } from './db'
import { decideEntry, submitSubmission } from './entries'
import { createPublisher } from './publisher'
import { claimNextDue } from './queue'
import type { PublishResult } from './status'

const NOW = 1_700_000_000_000
const SETUP_NOW = NOW - 60_000
const ACTOR = { user: 'author', account: 'account' }
const ADMIN = { user: 'admin', account: 'admin-account' }
let dir: string
let db: SqliteDatabase
let clock: { now: number }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'outbox-publisher-'))
  db = openDatabase(join(dir, 'db.sqlite'))
  clock = { now: NOW }
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function approve(text: string, scheduledAt: number) {
  const created = submitSubmission(db, {
    text,
    scheduledAt,
    checks: { blocking: [] },
    actor: ACTOR,
    now: SETUP_NOW
  })
  if (!created.ok) {
    throw new Error('submission failed')
  }
  const decided = decideEntry(db, {
    entryId: created.entryId,
    decision: 'approve',
    actor: ADMIN,
    now: SETUP_NOW
  })
  if (!decided.ok) {
    throw new Error('approval failed')
  }
  return db.prepare(
    'SELECT id FROM scheduled_posts WHERE entryId = ?'
  ).get(created.entryId) as { id: string }
}

function harness(
  postTweet: (
    text: string,
    deadline: number,
    imageBytes?: Buffer | Uint8Array | null
  ) => Promise<{ result: PublishResult; needsLogin: boolean }>,
  probe: () => Promise<'ok' | 'bad'> = async () => 'ok'
) {
  const alerts: Alert[] = []
  const logs: string[] = []
  const publisher = createPublisher({
    db,
    x: { probe, postTweet },
    alert: (alert) => alerts.push(alert),
    log: (line) => logs.push(line),
    now: () => clock.now,
    intervalMs: 1_000_000,
    budgetMs: 90_000,
    reprobeMs: 100
  })
  return { publisher, alerts, logs }
}

function status(postId: string): string {
  return (
    db.prepare('SELECT status FROM scheduled_posts WHERE id = ?')
      .get(postId) as { status: string }
  ).status
}

describe('serial publisher', () => {
  it('clears running state when boot interruption alerts fail', async () => {
    approve('interrupted post', NOW)
    claimNextDue(db, NOW)
    let alertCalls = 0
    const publisher = createPublisher({
      db,
      x: {
        probe: async () => 'ok',
        postTweet: async () => ({
          result: { channel: 'x', ok: true },
          needsLogin: false
        })
      },
      alert: () => {
        alertCalls += 1
        throw new Error('alert failed')
      },
      log: () => {},
      now: () => clock.now,
      intervalMs: 1_000_000
    })

    await expect(publisher.start()).rejects.toThrow('alert failed')
    expect(publisher.running()).toBe(false)
    await publisher.start()
    expect(publisher.running()).toBe(true)
    expect(alertCalls).toBe(1)
    await publisher.stop()
  })

  it('marks an in-flight post uncertain and alerts when the process starts again', async () => {
    const post = approve('interrupted post', NOW)
    claimNextDue(db, NOW)
    const { publisher, alerts } = harness(async () => ({
      result: { channel: 'x', ok: true },
      needsLogin: false
    }))
    await publisher.start()
    expect(status(post.id)).toBe('uncertain')
    expect(alerts).toEqual([{
      kind: 'interrupted',
      postId: post.id,
      detail: 'interrupted by restart'
    }])
    await publisher.stop()
  })

  it('sends one approved due post and stores its permalink', async () => {
    const post = approve('approved text', NOW)
    let sends = 0
    const { publisher, alerts } = harness(async () => {
      sends += 1
      return {
        result: {
          channel: 'x',
          ok: true,
          url: 'https://x.com/test/status/7'
        },
        needsLogin: false
      }
    })
    await publisher.start()
    await publisher.tick()
    expect(sends).toBe(1)
    expect(
      db.prepare('SELECT status, url FROM scheduled_posts WHERE id = ?')
        .get(post.id)
    ).toEqual({ status: 'sent', url: 'https://x.com/test/status/7' })
    expect(alerts).toEqual([])
    await publisher.stop()
  })

  it('marks a successful X post uncertain when saving its result fails', async () => {
    const post = approve('result cannot be saved', NOW)
    db.exec(`
      CREATE TRIGGER fail_sent
      BEFORE INSERT ON publish_results
      WHEN NEW.ok = 1
      BEGIN
        SELECT RAISE(ABORT, 'disk full');
      END
    `)
    let sends = 0
    const { publisher, alerts } = harness(async () => {
      sends += 1
      return { result: { channel: 'x', ok: true }, needsLogin: false }
    })

    await publisher.start()
    await publisher.tick()
    expect(sends).toBe(1)
    expect(status(post.id)).toBe('uncertain')
    expect(alerts).toEqual([{
      kind: 'uncertain',
      postId: post.id,
      detail: 'unexpected publisher failure'
    }])

    await publisher.tick()
    expect(sends).toBe(1)
    expect(status(post.id)).toBe('uncertain')
    await publisher.stop()
  })

  it('marks a preparation failure failed when recording that result fails before X dispatch', async () => {
    const imageBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1])
    const created = submitSubmission(db, {
      text: 'image preparation failure',
      scheduledAt: NOW,
      imageBytes,
      checks: { blocking: [] },
      actor: ACTOR,
      now: SETUP_NOW
    })
    if (!created.ok) throw new Error('submission failed')
    const decided = decideEntry(db, {
      entryId: created.entryId,
      decision: 'approve',
      actor: ADMIN,
      now: SETUP_NOW
    })
    if (!decided.ok) throw new Error('approval failed')
    const post = db.prepare('SELECT id FROM scheduled_posts WHERE entryId = ?')
      .get(created.entryId) as { id: string }
    db.prepare('DELETE FROM media WHERE sha256 = (SELECT imageSha256 FROM entries WHERE id = ?)')
      .run(created.entryId)
    db.exec(`
      CREATE TRIGGER fail_missing_image_result
      BEFORE INSERT ON publish_results
      WHEN NEW.error = 'image missing'
      BEGIN
        SELECT RAISE(ABORT, 'cannot record missing image');
      END
    `)
    let sends = 0
    const { publisher, alerts } = harness(async () => {
      sends += 1
      return { result: { channel: 'x', ok: true }, needsLogin: false }
    })

    await publisher.start()
    await publisher.tick()

    expect(sends).toBe(0)
    expect(status(post.id)).toBe('failed')
    expect(alerts).toEqual([{
      kind: 'failed',
      postId: post.id,
      detail: 'unexpected publisher failure'
    }])
    await publisher.stop()
  })

  it('does not send when the boot probe is bad', async () => {
    const post = approve('future', NOW + 50)
    let sends = 0
    const { publisher } = harness(async () => {
      sends += 1
      return { result: { channel: 'x', ok: true }, needsLogin: false }
    }, async () => 'bad')
    await publisher.start()
    await publisher.tick()
    expect(status(post.id)).toBe('pending')
    clock.now += 50
    await publisher.tick()
    expect(sends).toBe(0)
    await publisher.stop()
  })

  it('waits until the tick after a successful recovery probe to send', async () => {
    const post = approve('send after recovery', NOW)
    let probes = 0
    let sends = 0
    const { publisher } = harness(async () => {
      sends += 1
      return { result: { channel: 'x', ok: true }, needsLogin: false }
    }, async () => {
      probes += 1
      return probes === 1 ? 'bad' : 'ok'
    })

    await publisher.start()
    clock.now += 100
    await publisher.tick()
    expect(probes).toBe(2)
    expect(sends).toBe(0)
    expect(status(post.id)).toBe('pending')

    await publisher.tick()
    expect(sends).toBe(1)
    expect(status(post.id)).toBe('sent')
    await publisher.stop()
  })

  it('waits until scheduledAt before sending with a good probe', async () => {
    const post = approve('not due yet', NOW + 50)
    let sends = 0
    const { publisher } = harness(async () => {
      sends += 1
      return { result: { channel: 'x', ok: true }, needsLogin: false }
    })
    await publisher.start()
    await publisher.tick()
    expect(sends).toBe(0)
    expect(status(post.id)).toBe('pending')
    clock.now += 50
    await publisher.tick()
    expect(sends).toBe(1)
    expect(status(post.id)).toBe('sent')
    await publisher.stop()
  })

  it('publishes an image post after verifying its stored bytes', async () => {
    const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1])
    const created = submitSubmission(db, {
      text: 'image copy',
      scheduledAt: NOW,
      imageBytes: image,
      checks: { blocking: [] },
      actor: ACTOR,
      now: SETUP_NOW
    })
    if (!created.ok) {
      throw new Error('submission failed')
    }
    const decided = decideEntry(db, {
      entryId: created.entryId,
      decision: 'approve',
      actor: ADMIN,
      now: SETUP_NOW
    })
    if (!decided.ok) {
      throw new Error('approval failed')
    }
    const post = db.prepare(
      'SELECT id FROM scheduled_posts WHERE entryId = ?'
    ).get(created.entryId) as { id: string }
    let sends = 0
    const { publisher } = harness(async (_text, _deadline, uploaded) => {
      sends += 1
      expect(Buffer.from(uploaded!).equals(image)).toBe(true)
      return { result: { channel: 'x', ok: true }, needsLogin: false }
    })
    await publisher.start()
    await publisher.tick()
    expect(sends).toBe(1)
    expect(status(post.id)).toBe('sent')
    await publisher.stop()
  })

  it('marks a missing media row failed without calling X', async () => {
    const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1])
    const created = submitSubmission(db, { text: 'image copy', scheduledAt: NOW, imageBytes: image, checks: { blocking: [] }, actor: ACTOR, now: SETUP_NOW })
    if (!created.ok) throw new Error('submission failed')
    const approved = decideEntry(db, { entryId: created.entryId, decision: 'approve', actor: ADMIN, now: SETUP_NOW })
    if (!approved.ok) throw new Error('approval failed')
    const row = db.prepare('SELECT p.id, e.imageSha256 FROM scheduled_posts p JOIN entries e ON e.id = p.entryId WHERE p.entryId = ?').get(created.entryId) as { id: string; imageSha256: string }
    db.prepare('DELETE FROM media WHERE sha256 = ?').run(row.imageSha256)
    let sends = 0
    const { publisher } = harness(async () => {
      sends += 1
      return { result: { channel: 'x', ok: true }, needsLogin: false }
    })
    await publisher.start()
    await publisher.tick()
    expect(sends).toBe(0)
    expect(status(row.id)).toBe('failed')
    await publisher.stop()
  })

  it('marks media lookup errors failed without calling X or marking uncertain', async () => {
    const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1])
    const created = submitSubmission(db, { text: 'image lookup error', scheduledAt: NOW, imageBytes: image, checks: { blocking: [] }, actor: ACTOR, now: SETUP_NOW })
    if (!created.ok) throw new Error('submission failed')
    const approved = decideEntry(db, { entryId: created.entryId, decision: 'approve', actor: ADMIN, now: SETUP_NOW })
    if (!approved.ok) throw new Error('approval failed')
    const row = db.prepare('SELECT id FROM scheduled_posts WHERE entryId = ?').get(created.entryId) as { id: string }
    db.prepare('ALTER TABLE media RENAME TO unavailable_media').run()
    let sends = 0
    const { publisher } = harness(async () => {
      sends += 1
      return { result: { channel: 'x', ok: true }, needsLogin: false }
    })
    await publisher.start()
    await publisher.tick()
    expect(sends).toBe(0)
    expect(status(row.id)).toBe('failed')
    await publisher.stop()
  })

  it('does not send an uncertain post again on a later tick', async () => {
    const post = approve('uncertain once', NOW)
    let sends = 0
    const { publisher } = harness(async () => {
      sends += 1
      return {
        result: {
          channel: 'x',
          ok: false,
          uncertain: true,
          error: 'timeout'
        },
        needsLogin: false
      }
    })
    await publisher.start()
    await publisher.tick()
    await publisher.tick()
    expect(sends).toBe(1)
    expect(status(post.id)).toBe('uncertain')
    await publisher.stop()
  })

  it('does not overlap posts and does not requeue an uncertain outcome', async () => {
    approve('one', NOW)
    approve('two', NOW)
    let active = 0
    let maxActive = 0
    let sends = 0
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { publisher } = harness(async () => {
      active += 1
      maxActive = Math.max(active, maxActive)
      sends += 1
      if (sends === 1) {
        await gate
      }
      active -= 1
      return {
        result: {
          channel: 'x',
          ok: false,
          uncertain: true,
          error: 'timeout'
        },
        needsLogin: false
      }
    })
    await publisher.start()
    const firstTick = publisher.tick()
    const secondTick = publisher.tick()
    release()
    await Promise.all([firstTick, secondTick])
    await publisher.tick()
    expect(maxActive).toBe(1)
    expect(sends).toBe(2)
    expect(
      db.prepare(
        "SELECT COUNT(*) AS n FROM scheduled_posts WHERE status = 'uncertain'"
      ).get()
    ).toEqual({ n: 2 })
    await publisher.stop()
  })

  it('fails stale content without an X call and alerts for failed and uncertain outcomes', async () => {
    const tampered = approve('original', NOW)
    const failed = approve('rejected', NOW + 1)
    const uncertain = approve('unknown', NOW + 2)
    const tamperedEntry = (
      db.prepare('SELECT entryId FROM scheduled_posts WHERE id = ?')
        .get(tampered.id) as { entryId: string }
    ).entryId
    db.prepare('UPDATE entries SET text = ? WHERE id = ?')
      .run('changed', tamperedEntry)
    let calls = 0
    const { publisher, alerts } = harness(async (text) => {
      calls += 1
      return {
        result: {
          channel: 'x',
          ok: false,
          ...(text === 'rejected'
            ? { error: 'HTTP 403' }
            : { uncertain: true, error: 'timeout' })
        },
        needsLogin: false
      }
    })
    clock.now += 2
    await publisher.start()
    await publisher.tick()
    await publisher.tick()
    await publisher.tick()
    expect(calls).toBe(2)
    expect(status(tampered.id)).toBe('failed')
    expect(alerts.map((item) => item.kind)).toEqual([
      'failed',
      'failed',
      'uncertain'
    ])
    expect(status(failed.id)).toBe('failed')
    expect(status(uncertain.id)).toBe('uncertain')
    await publisher.stop()
  })

  it('stop waits for the running post and emits the needs-login alert', async () => {
    approve('one', NOW)
    approve('two', NOW)
    let sends = 0
    let finish: () => void = () => {}
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    const { publisher, alerts } = harness(async () => {
      sends += 1
      if (sends === 1) {
        await pending
      }
      return {
        result: { channel: 'x', ok: false, error: 'HTTP 401' },
        needsLogin: true
      }
    })
    await publisher.start()
    const tick = publisher.tick()
    let stopped = false
    const stopping = publisher.stop().then(() => {
      stopped = true
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(stopped).toBe(false)
    finish()
    await tick
    await stopping
    expect(stopped).toBe(true)
    expect(publisher.running()).toBe(false)
    expect(alerts.some((item) => item.kind === 'needs-login')).toBe(true)
    expect(sends).toBe(1)
  })

  it('keeps the failed result and pauses sends when a needs-login alert throws', async () => {
    const firstPost = approve('login needed', NOW - 30_000)
    const secondPost = approve('wait for recovery', NOW - 20_000)
    let sends = 0
    const logs: string[] = []
    const publisher = createPublisher({
      db,
      x: {
        probe: async () => 'ok',
        postTweet: async () => {
          sends += 1
          return {
            result: { channel: 'x', ok: false, error: 'HTTP 401' },
            needsLogin: true
          }
        }
      },
      alert: () => {
        throw new Error('alert failed')
      },
      log: (line) => logs.push(line),
      now: () => clock.now,
      intervalMs: 1_000_000,
      reprobeMs: 100
    })

    await publisher.start()
    await publisher.tick()
    expect(publisher.probeState()).toBe('bad')
    expect(status(firstPost.id)).toBe('failed')
    expect(logs).toEqual(['Publisher alert failed'])

    await publisher.tick()
    expect(sends).toBe(1)
    expect(status(secondPost.id)).toBe('pending')
    await publisher.stop()
  })

  it('keeps sends paused through a successful later probe', async () => {
    approve('login needed', NOW)
    approve('after recovery', NOW)
    let sends = 0
    let probes = 0
    const { publisher } = harness(async () => {
      sends += 1
      return sends === 1
        ? {
            result: { channel: 'x', ok: false, error: 'HTTP 401' },
            needsLogin: true
          }
        : { result: { channel: 'x', ok: true }, needsLogin: false }
    }, async () => {
      probes += 1
      return 'ok'
    })
    await publisher.start()
    await publisher.tick()
    await publisher.tick()
    expect(sends).toBe(1)
    clock.now += 100
    await publisher.tick()
    expect(probes).toBe(2)
    expect(sends).toBe(1)
    await publisher.tick()
    expect(sends).toBe(2)
    await publisher.stop()
  })

  it('logs and recovers when the due-post claim throws once', async () => {
    const post = approve('recover after claim failure', NOW)
    db.exec(`
      CREATE TRIGGER fail_claim_once
      BEFORE UPDATE ON scheduled_posts
      WHEN NEW.status = 'in-flight'
      BEGIN
        SELECT RAISE(ABORT, 'claim failed');
      END
    `)
    let sends = 0
    const { publisher, logs } = harness(async () => {
      sends += 1
      return { result: { channel: 'x', ok: true }, needsLogin: false }
    })
    await publisher.start()
    await expect(publisher.tick()).resolves.toBeUndefined()
    expect(sends).toBe(0)
    expect(status(post.id)).toBe('pending')
    expect(logs).toEqual(['Publisher tick failed before claim'])

    db.exec('DROP TRIGGER fail_claim_once')
    await publisher.tick()
    expect(sends).toBe(1)
    expect(status(post.id)).toBe('sent')
    await publisher.stop()
  })
})
