import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase, type SqliteDatabase } from './db'
import { submitSubmission } from './entries'
import { imageSha256 } from './content-hash'
import type { Identity, Introspect } from './identity'
import {
  createOutboxServer,
  sessionCookie,
  type OutboxServerDeps
} from './server'

const NOW = Date.UTC(2023, 0, 1, 0, 0, 0)
const CLEAN = 'The specification defines a design, not a live product.'
const BLOCKING = 'This design is trustless under the right assumptions.'
const FUTURE_LOCAL = '2024-07-15T12:00'
const WINTER_LOCAL = '2024-01-15T12:00'
const PAST_LOCAL = '2020-01-15T12:00'
const SUMMER_EPOCH = Date.UTC(2024, 6, 15, 10, 0, 0)
const WINTER_EPOCH = Date.UTC(2024, 0, 15, 11, 0, 0)

const TOKEN_A = 'token-outbox-a'
const TOKEN_B = 'token-outbox-b'
const TOKEN_ADMIN = 'token-admin'
const SEKRIT_BEARER = 'sekrit-bearer-aabbcc'
const SEKRIT_COOKIE = 'sekrit-cookie-xxyyzz'

const PEOPLE: Record<string, Identity> = {
  [TOKEN_A]: { user: 'user-a', account: 'account-a', role: 'OUTBOX' },
  [TOKEN_B]: { user: 'user-b', account: 'account-b', role: 'OUTBOX' },
  [TOKEN_ADMIN]: { user: 'user-admin', account: 'account-admin', role: 'ADMIN' },
  [SEKRIT_BEARER]: { user: 'user-a', account: 'account-a', role: 'OUTBOX' }
}

const introspect: Introspect = async (token, role) => {
  const person = PEOPLE[token]
  if (!person) return { ok: false, status: 401 }
  if (role === 'ADMIN' && person.role !== 'ADMIN') return { ok: false, status: 403 }
  return { ok: true, ...person }
}

type Harness = {
  port: number
  db: SqliteDatabase
  logs: string[]
  clock: { now: number }
  close: () => Promise<void>
}

const harnesses: Harness[] = []
const FONT_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), 'assets', 'fonts')

function assertServerRequiresBrand(
  deps: Omit<OutboxServerDeps, 'brand'>
): void {
  // @ts-expect-error A server must receive its configured brand explicitly.
  createOutboxServer(deps)
}

void assertServerRequiresBrand

afterEach(async () => {
  while (harnesses.length > 0) {
    const h = harnesses.pop()!
    await h.close()
  }
})

function listenZero(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr === null || typeof addr === 'string') {
        reject(new Error('expected a TCP address'))
        return
      }
      resolve(addr.port)
    })
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()))
  })
}

async function start(
  opts: {
    pack?: boolean
    jwtSecret?: string
    probeX?: () => 'ok' | 'bad'
    introspect?: Introspect
    publisher?: { running(): boolean }
  } = {}
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'outbox-surface-'))
  const db = openDatabase(join(dir, 'state.sqlite'))
  const packRoot = join(dir, 'pack')
  if (opts.pack === false) {
    mkdirSync(packRoot, { recursive: true })
  } else {
    mkdirSync(join(packRoot, 'content', 'dfx'), { recursive: true })
    writeFileSync(
      join(packRoot, 'content', 'dfx', 'rules.json'),
      JSON.stringify({
        topic: 'dfx',
        forbiddenClaims: ['\\btrustless\\b'],
        micarUnsafe: [],
        provisionalParameters: []
      })
    )
  }
  const clock = { now: NOW }
  const logs: string[] = []
  const server = createOutboxServer({
    db,
    packRoot,
    brand: 'dfx',
    introspect: opts.introspect ?? introspect,
    now: () => clock.now,
    jwtSecret: opts.jwtSecret ?? 'test-jwt-secret',
    log: (line) => logs.push(line),
    probeX: opts.probeX,
    publisher: opts.publisher
  })
  const port = await listenZero(server)
  const harness: Harness = {
    port,
    db,
    logs,
    clock,
    close: async () => {
      await closeServer(server)
      db.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
  harnesses.push(harness)
  return harness
}

async function call(
  port: number,
  path: string,
  init: RequestInit & { token?: string; origin?: string | null } = {}
): Promise<{
  status: number
  text: string
  json: unknown
  headers: Headers
  location: string | null
}> {
  const { token, origin, headers: initHeaders, ...rest } = init
  const headers = new Headers(initHeaders)
  if (token) headers.set('authorization', `Bearer ${token}`)
  if (origin === undefined) headers.set('origin', `http://127.0.0.1:${port}`)
  else if (origin !== null) headers.set('origin', origin)
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...rest,
    headers,
    redirect: 'manual'
  })
  const text = await res.text()
  let json: unknown = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return {
    status: res.status,
    text,
    json,
    headers: res.headers,
    location: res.headers.get('location')
  }
}

function submitJson(
  port: number,
  token: string,
  body: { text: string; scheduledAt: string },
  origin?: string | null
) {
  return call(port, '/api/submit', {
    method: 'POST',
    token,
    origin,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
}

function entryCount(db: SqliteDatabase): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM entries').get() as { n: number }).n
}

function queueFor(
  db: SqliteDatabase,
  entryId: string
): Array<{ channel: string; status: string }> {
  return db
    .prepare('SELECT channel, status FROM scheduled_posts WHERE entryId = ?')
    .all(entryId) as Array<{ channel: string; status: string }>
}

function auditReasons(db: SqliteDatabase): string[] {
  return (db.prepare('SELECT reason FROM audit ORDER BY at ASC, id ASC').all() as Array<{
    reason: string | null
  }>).map((row) => row.reason ?? '')
}

describe('GET / composer', () => {
  it('preselects the next Zurich date, hour, and minute', async () => {
    const h = await start()
    const response = await call(h.port, '/', { token: TOKEN_A })

    expect(response.status).toBe(200)
    expect(response.text).toContain('id="scheduledDate" name="scheduledDate" type="date" required value="2023-01-01"')
    expect(response.text.match(/<option value="01" selected>01<\/option>/g)).toHaveLength(1)
    expect(response.text.match(/<option value="10" selected>10<\/option>/g)).toHaveLength(1)
  })
})

describe('POST /api/submit', () => {
  it('rejects seconds that are not zero and accepts a five-minute datetime with zero seconds', async () => {
    const h = await start()
    const withSeconds = await submitJson(h.port, TOKEN_A, {
      text: CLEAN,
      scheduledAt: '2024-07-15T12:05:30'
    })
    expect(withSeconds.status).toBe(400)
    expect(withSeconds.json).toMatchObject({
      reason: 'invalid-request',
      detail: 'Scheduled time must be on a 5-minute step.'
    })

    const zeroSeconds = await submitJson(h.port, TOKEN_A, {
      text: CLEAN,
      scheduledAt: '2024-07-15T12:05:00'
    })
    expect(zeroSeconds.status).toBe(200)
    expect(zeroSeconds.json).toMatchObject({ ok: true })
  })

  it('requires 5-minute steps for datetime and date/hour/minute inputs', async () => {
    const h = await start()
    const json = await submitJson(h.port, TOKEN_A, { text: CLEAN, scheduledAt: '2024-07-15T12:01' })
    expect(json.status).toBe(400)
    expect(json.json).toMatchObject({ reason: 'invalid-request', detail: 'Scheduled time must be on a 5-minute step.' })
    const form = await call(h.port, '/api/submit', {
      method: 'POST', token: TOKEN_A,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ text: CLEAN, scheduledDate: '2024-07-15', scheduledHour: '12', scheduledMinute: '01' }).toString()
    })
    expect(form.status).toBe(400)
    expect(form.text).toContain('Scheduled time must be on a 5-minute step.')
    expect(entryCount(h.db)).toBe(0)
  })

  it('deduplicates identical images across submissions and stores a different image separately', async () => {
    const h = await start()
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1])
    const submitImage = async (minute: string, image: Uint8Array) => {
      const form = new FormData()
      form.set('text', CLEAN)
      form.set('scheduledDate', '2024-07-15')
      form.set('scheduledHour', '12')
      form.set('scheduledMinute', minute)
      form.set('image', new Blob([image], { type: 'application/octet-stream' }), 'chosen.bin')
      const response = await call(h.port, '/api/submit', {
        method: 'POST', token: TOKEN_A, headers: { accept: 'application/json' }, body: form
      })
      expect(response.status).toBe(200)
      const body = response.json as { entryId: string }
      return (h.db.prepare('SELECT imageSha256 FROM entries WHERE id = ?').get(body.entryId) as { imageSha256: string }).imageSha256
    }
    const firstSha = await submitImage('05', bytes)
    const duplicateSha = await submitImage('10', bytes)
    const otherSha = await submitImage('15', new Uint8Array([...bytes, 2]))

    expect(firstSha).toBe(imageSha256(bytes))
    expect(duplicateSha).toBe(firstSha)
    expect(otherSha).not.toBe(firstSha)
    expect(h.db.prepare('SELECT COUNT(*) AS n FROM media').get()).toEqual({ n: 2 })
    expect(h.db.prepare('SELECT mime FROM media WHERE sha256 = ?').get(firstSha)).toEqual({ mime: 'image/png' })
  })

  it('rejects multipart text fields larger than the body limit', async () => {
    const h = await start()
    const form = new FormData()
    form.set('text', 'x'.repeat(1_000_001))
    const response = await call(h.port, '/api/submit', {
      method: 'POST', token: TOKEN_A, headers: { accept: 'application/json' }, body: form
    })
    expect(response.status).toBe(413)
  })

  it('accepts JPEG bytes and treats an empty file input as no image', async () => {
    const h = await start()
    const submitForm = async (image: Blob, filename: string) => {
      const form = new FormData()
      form.set('text', CLEAN)
      form.set('scheduledDate', '2024-07-15')
      form.set('scheduledHour', '12')
      form.set('scheduledMinute', '10')
      form.set('image', image, filename)
      return call(h.port, '/api/submit', { method: 'POST', token: TOKEN_A, headers: { accept: 'application/json' }, body: form })
    }
    const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 1])
    const jpeg = await submitForm(new Blob([jpegBytes], { type: 'image/png' }), 'reported-png.png')
    expect(jpeg.status).toBe(200)
    const jpegBody = jpeg.json as { entryId: string }
    const jpegEntry = h.db.prepare('SELECT imageSha256 FROM entries WHERE id = ?').get(jpegBody.entryId) as { imageSha256: string }
    expect(h.db.prepare('SELECT mime FROM media WHERE sha256 = ?').get(jpegEntry.imageSha256)).toEqual({ mime: 'image/jpeg' })

    const empty = await submitForm(new Blob([], { type: 'image/png' }), 'empty.png')
    expect(empty.status).toBe(200)
    const emptyBody = empty.json as { entryId: string }
    expect(h.db.prepare('SELECT imageSha256 FROM entries WHERE id = ?').get(emptyBody.entryId)).toEqual({ imageSha256: null })
  })

  it('rejects a non-PNG/JPEG signature', async () => {
    const h = await start()
    const invalid = new FormData()
    invalid.set('text', CLEAN)
    invalid.set('scheduledDate', '2024-07-15')
    invalid.set('scheduledHour', '12')
    invalid.set('scheduledMinute', '05')
    invalid.set('image', new Blob(['not an image'], { type: 'image/png' }), 'fake.png')
    const bad = await call(h.port, '/api/submit', { method: 'POST', token: TOKEN_A, headers: { accept: 'application/json' }, body: invalid })
    expect(bad.status).toBe(409)
    expect(bad.json).toMatchObject({ reason: 'bad-image', detail: 'Image must be a PNG or JPEG up to 5 MB.' })

    expect(entryCount(h.db)).toBe(0)
  })

  it('enforces the image size limit for correctly signed PNG files', async () => {
    const h = await start()
    const submitPng = async (size: number) => {
      const bytes = new Uint8Array(size)
      bytes.set([137, 80, 78, 71, 13, 10, 26, 10])
      const form = new FormData()
      form.set('text', CLEAN)
      form.set('scheduledDate', '2024-07-15')
      form.set('scheduledHour', '12')
      form.set('scheduledMinute', '05')
      form.set('image', new Blob([bytes], { type: 'image/png' }), 'image.png')
      return call(h.port, '/api/submit', {
        method: 'POST', token: TOKEN_A,
        headers: { accept: 'application/json' }, body: form
      })
    }

    const tooLarge = await submitPng(5 * 1024 * 1024 + 1)
    expect(tooLarge.status).toBe(409)
    expect(tooLarge.json).toMatchObject({ reason: 'bad-image' })
    const atLimit = await submitPng(5 * 1024 * 1024)
    expect(atLimit.status).toBe(200)
    expect(entryCount(h.db)).toBe(1)
  })

  it('rejects a JSON field that is not a string and writes no entry', async () => {
    const h = await start()
    const res = await call(h.port, '/api/submit', {
      method: 'POST',
      token: TOKEN_A,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: { x: 1 }, scheduledAt: FUTURE_LOCAL })
    })
    expect(res.status).toBe(400)
    expect(res.json).toMatchObject({ ok: false, reason: 'invalid-request' })
    expect(res.text).toContain('JSON fields must be strings.')
    expect(entryCount(h.db)).toBe(0)
  })

  it('returns 409 and writes no entry when a blocking finding is present', async () => {
    const h = await start()
    const res = await submitJson(h.port, TOKEN_A, { text: BLOCKING, scheduledAt: FUTURE_LOCAL })
    expect(res.status).toBe(409)
    expect(res.json).toMatchObject({ ok: false, reason: 'blocking-review' })
    expect(entryCount(h.db)).toBe(0)
  })

  it('renders a blocking finding page with an enabled submit button for an HTML form submit', async () => {
    const h = await start()
    const res = await call(h.port, '/api/submit', {
      method: 'POST',
      token: TOKEN_A,
      headers: {
        accept: 'text/html',
        'content-type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({ text: BLOCKING, scheduledAt: FUTURE_LOCAL }).toString()
    })

    expect(res.status).toBe(409)
    expect(res.text).toContain('Blocking review finding.')
    const submitButton = res.text.match(/<button id="submit-button"[^>]*>/)?.[0]
    expect(submitButton).toBeDefined()
    expect(submitButton).not.toMatch(/\sdisabled(?:\s|=|>)/)
  })

  it('returns 409 when the scheduled time is already past', async () => {
    const h = await start()
    const res = await submitJson(h.port, TOKEN_A, { text: CLEAN, scheduledAt: PAST_LOCAL })
    expect(res.status).toBe(409)
    expect(res.json).toMatchObject({ ok: false, reason: 'past-time' })
    expect(entryCount(h.db)).toBe(0)
  })

  it('returns 409 without a pack, and healthz reports ok false', async () => {
    const h = await start({ pack: false })
    const res = await submitJson(h.port, TOKEN_A, { text: CLEAN, scheduledAt: FUTURE_LOCAL })
    expect(res.status).toBe(409)
    expect(res.json).toMatchObject({ ok: false, reason: 'missing-pack' })
    expect(entryCount(h.db)).toBe(0)
    const health = await call(h.port, '/healthz')
    expect(health.status).toBe(200)
    expect(health.json).toMatchObject({
      ok: false,
      queueRunning: false,
      probes: { x: 'bad', jwt: 'ok' }
    })
  })

  it('does not present a missing pack as an empty review result', async () => {
    const h = await start({ pack: false })
    const form = new FormData()
    form.set('text', CLEAN)
    form.set('scheduledAt', FUTURE_LOCAL)
    form.set('image', new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], { type: 'image/png' }), 'image.png')
    const res = await call(h.port, '/api/submit', {
      method: 'POST',
      token: TOKEN_A,
      headers: { accept: 'text/html' },
      body: form
    })
    expect(res.status).toBe(409)
    expect(res.text).toContain('No usable review check is recorded.')
    expect(res.text).not.toContain('No blocking findings and no hints.')
    expect(res.text).toContain('Review pack is missing.')
    expect(res.text).not.toContain('Checked:')
    expect(res.text).not.toContain('Not checked:')
    expect(res.text).toContain('Choose the image again — it was not kept.')
    expect(entryCount(h.db)).toBe(0)
  })

  it('creates a submitted entry that is visible on GET /review/:id', async () => {
    const h = await start()
    const form = await call(h.port, '/api/submit', {
      method: 'POST',
      token: TOKEN_A,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ text: CLEAN, scheduledAt: FUTURE_LOCAL }).toString()
    })
    expect(form.status).toBe(303)
    expect(form.location).toMatch(/^\/review\/[0-9a-f-]+$/i)

    const res = await submitJson(h.port, TOKEN_A, { text: CLEAN, scheduledAt: FUTURE_LOCAL })
    expect(res.status).toBe(200)
    const created = res.json as { ok: true; bundleId: string; entryId: string }
    expect(created.ok).toBe(true)
    const row = h.db
      .prepare('SELECT state FROM entries WHERE id = ?')
      .get(created.entryId) as { state: string }
    expect(row.state).toBe('submitted')

    const page = await call(h.port, `/review/${created.bundleId}`, { token: TOKEN_A })
    expect(page.status).toBe(200)
    expect(page.text).toContain(CLEAN)
    expect(page.text).not.toContain('Checked:')
    expect(page.text).not.toContain('Not checked:')
    expect(page.text).toContain('Europe/Zurich')
    expect(page.text).not.toContain(TOKEN_A)
  })
})

describe('GET /review/:id', () => {
  it('does not present a missing check as an empty review result', async () => {
    const h = await start()
    const created = submitSubmission(h.db, {
      text: CLEAN,
      scheduledAt: SUMMER_EPOCH,
      checks: null,
      actor: { user: 'user-a', account: 'account-a' },
      now: NOW
    })
    if (!created.ok) throw new Error('expected submit to succeed')

    const page = await call(h.port, `/review/${created.bundleId}`, { token: TOKEN_ADMIN })
    expect(page.status).toBe(200)
    expect(page.text).toContain('No usable review check is recorded.')
    expect(page.text).not.toContain('No blocking findings and no hints.')
    expect(page.text).not.toContain('Checked:')
    expect(page.text).not.toContain('Not checked:')
    expect(page.text).toContain(
      'No review check is recorded, so this entry cannot be approved.'
    )
  })
})

describe('POST /review/:id/decide', () => {
  it('does not approve when introspect returns OUTBOX for an ADMIN route', async () => {
    const permissive: Introspect = async (token) => {
      const person = PEOPLE[token]
      if (!person) return { ok: false, status: 401 }
      return { ok: true, user: person.user, account: person.account, role: 'OUTBOX' }
    }
    const h = await start({ introspect: permissive })
    const created = (await submitJson(h.port, TOKEN_A, { text: CLEAN, scheduledAt: FUTURE_LOCAL }))
      .json as { bundleId: string; entryId: string }

    const res = await call(h.port, `/review/${created.bundleId}/decide`, {
      method: 'POST',
      token: TOKEN_A,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' })
    })
    expect(res.status).toBe(403)
    expect(queueFor(h.db, created.entryId)).toEqual([])
    const row = h.db
      .prepare('SELECT state FROM entries WHERE id = ?')
      .get(created.entryId) as { state: string }
    expect(row.state).toBe('submitted')
  })

  it('approve as Admin inserts a queue row; as OUTBOX it is 403', async () => {
    const h = await start()
    const created = (await submitJson(h.port, TOKEN_A, { text: CLEAN, scheduledAt: FUTURE_LOCAL }))
      .json as { bundleId: string; entryId: string }

    const denied = await call(h.port, `/review/${created.bundleId}/decide`, {
      method: 'POST',
      token: TOKEN_A,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' })
    })
    expect(denied.status).toBe(403)
    expect(queueFor(h.db, created.entryId)).toEqual([])

    const allowed = await call(h.port, `/review/${created.bundleId}/decide`, {
      method: 'POST',
      token: TOKEN_ADMIN,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' })
    })
    expect(allowed.status).toBe(200)
    expect(allowed.json).toMatchObject({ ok: true, state: 'approved' })
    expect(queueFor(h.db, created.entryId)).toEqual([{ channel: 'x', status: 'pending' }])
  })

  it('a second decide returns 409', async () => {
    const h = await start()
    const created = (await submitJson(h.port, TOKEN_A, { text: CLEAN, scheduledAt: FUTURE_LOCAL }))
      .json as { bundleId: string; entryId: string }
    const first = await call(h.port, `/review/${created.bundleId}/decide`, {
      method: 'POST',
      token: TOKEN_ADMIN,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' })
    })
    expect(first.status).toBe(200)
    const second = await call(h.port, `/review/${created.bundleId}/decide`, {
      method: 'POST',
      token: TOKEN_ADMIN,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' })
    })
    expect(second.status).toBe(409)
    expect(second.json).toMatchObject({ ok: false, reason: 'conflict' })
    expect(queueFor(h.db, created.entryId)).toHaveLength(1)
  })

  it('approve after the scheduled time returns 409 with the lock reason', async () => {
    const h = await start()
    const created = (await submitJson(h.port, TOKEN_A, { text: CLEAN, scheduledAt: FUTURE_LOCAL }))
      .json as { bundleId: string; entryId: string }
    h.clock.now = SUMMER_EPOCH + 1
    const page = await call(h.port, `/review/${created.bundleId}`, { token: TOKEN_ADMIN })
    expect(page.status).toBe(200)
    expect(page.text).toContain(
      'The scheduled time has already passed, so this entry cannot be approved.'
    )
    expect(page.text).not.toContain('value="approve"')
    const res = await call(h.port, `/review/${created.bundleId}/decide`, {
      method: 'POST',
      token: TOKEN_ADMIN,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' })
    })
    expect(res.status).toBe(409)
    expect(res.json).toMatchObject({ ok: false, reason: 'not-approvable' })
    expect(res.text).toContain(
      'The scheduled time has already passed, so this entry cannot be approved.'
    )
    expect(queueFor(h.db, created.entryId)).toEqual([])
  })
})

describe('visibility', () => {
  it('an OUTBOX account does not see another account\'s entries', async () => {
    const h = await start()
    const created = (await submitJson(h.port, TOKEN_A, { text: CLEAN, scheduledAt: FUTURE_LOCAL }))
      .json as { bundleId: string; entryId: string }

    const listB = await call(h.port, '/api/posts', { token: TOKEN_B })
    expect(listB.status).toBe(200)
    expect(listB.json).toEqual({ posts: [] })

    const reviewB = await call(h.port, `/review/${created.bundleId}`, { token: TOKEN_B })
    expect(reviewB.status).toBe(403)

    const listA = await call(h.port, '/api/posts', { token: TOKEN_A })
    expect(listA.status).toBe(200)
    const posts = (listA.json as { posts: Array<{ bundleId: string }> }).posts
    expect(posts).toHaveLength(1)
    expect(posts[0]?.bundleId).toBe(created.bundleId)

    const listAdmin = await call(h.port, '/api/posts', { token: TOKEN_ADMIN })
    expect(
      (listAdmin.json as { posts: Array<{ bundleId: string }> }).posts
    ).toHaveLength(1)
  })
})

describe('cross-site POST', () => {
  it('rejects a mutating POST with a Cookie and a foreign Origin and writes the attempt to audit', async () => {
    const h = await start()
    const res = await call(h.port, '/api/submit', {
      method: 'POST',
      origin: 'http://evil.example',
      headers: {
        'content-type': 'application/json',
        cookie: `outbox=${TOKEN_A}`
      },
      body: JSON.stringify({ text: CLEAN, scheduledAt: FUTURE_LOCAL })
    })
    expect(res.status).toBe(403)
    expect(res.json).toMatchObject({ ok: false, reason: 'origin-mismatch' })
    expect(entryCount(h.db)).toBe(0)
    expect(auditReasons(h.db)).toContain('origin-mismatch')
  })

  it('allows a mutating POST with Bearer and no Origin', async () => {
    const h = await start()
    const res = await submitJson(h.port, TOKEN_A, { text: CLEAN, scheduledAt: FUTURE_LOCAL }, null)
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ ok: true })
    expect(entryCount(h.db)).toBe(1)
    expect(auditReasons(h.db)).not.toContain('origin-mismatch')
  })
})

describe('datetime-local Europe/Zurich', () => {
  it('converts a winter datetime-local to the CET epoch millisecond', async () => {
    const h = await start()
    const res = await submitJson(h.port, TOKEN_A, { text: CLEAN, scheduledAt: WINTER_LOCAL })
    expect(res.status).toBe(200)
    const created = res.json as { entryId: string }
    const row = h.db
      .prepare('SELECT scheduledAt FROM entries WHERE id = ?')
      .get(created.entryId) as { scheduledAt: number }
    expect(row.scheduledAt).toBe(WINTER_EPOCH)
  })

  it('converts a summer datetime-local to the CEST epoch millisecond', async () => {
    const h = await start()
    const res = await submitJson(h.port, TOKEN_A, { text: CLEAN, scheduledAt: FUTURE_LOCAL })
    expect(res.status).toBe(200)
    const created = res.json as { entryId: string }
    const row = h.db
      .prepare('SELECT scheduledAt FROM entries WHERE id = ?')
      .get(created.entryId) as { scheduledAt: number }
    expect(row.scheduledAt).toBe(SUMMER_EPOCH)
  })
})

describe('no publish-now', () => {
  it('GET /api/publish, /api/schedule and /now are 404, and the composer has no publish control', async () => {
    const h = await start()
    for (const path of ['/api/publish', '/api/schedule', '/now']) {
      const get = await call(h.port, path, { token: TOKEN_A })
      expect(get.status).toBe(404)
      const post = await call(h.port, path, {
        method: 'POST',
        token: TOKEN_A,
        headers: { 'content-type': 'application/json' },
        body: '{}'
      })
      expect(post.status).toBe(404)
    }
    const home = await call(h.port, '/', { token: TOKEN_A })
    expect(home.status).toBe(200)
    expect(home.text).toContain('Submit for approval')
    expect(home.text).not.toContain('Checked:')
    expect(home.text).not.toContain('Not checked:')
    expect(home.text).not.toContain('Publish now')
    expect(home.text).not.toContain('/api/publish')
    expect(home.text).not.toContain('/api/schedule')
  })
})

describe('log denylist', () => {
  it('does not write Cookie or Bearer values into the log output', async () => {
    const h = await start()
    const res = await call(h.port, '/api/submit', {
      method: 'POST',
      origin: `http://127.0.0.1:${h.port}`,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${SEKRIT_BEARER}`,
        cookie: `outbox=${SEKRIT_COOKIE}`
      },
      body: JSON.stringify({ text: CLEAN, scheduledAt: FUTURE_LOCAL })
    })
    expect(res.status).toBe(200)
    const joined = h.logs.join('\n')
    expect(joined).toContain('Authorization:')
    expect(joined).toContain('Cookie:')
    expect(joined).not.toContain(SEKRIT_BEARER)
    expect(joined).not.toContain(SEKRIT_COOKIE)
    expect(joined).not.toMatch(/Bearer\s+(?!(\*\*\*))/i)
  })

  it('masks the session cookie when it is not the first cookie in the header', async () => {
    const h = await start()
    const res = await call(h.port, '/api/submit', {
      method: 'POST',
      origin: `http://127.0.0.1:${h.port}`,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${TOKEN_A}`,
        cookie: `cf_clearance=abc; outbox=${SEKRIT_COOKIE}; extra=1`
      },
      body: JSON.stringify({ text: CLEAN, scheduledAt: FUTURE_LOCAL })
    })
    expect(res.status).toBe(200)
    const joined = h.logs.join('\n')
    expect(joined).toContain('Cookie:')
    expect(joined).not.toContain(SEKRIT_COOKIE)
    expect(joined).not.toContain('outbox=')
  })
})

describe('POST /api/bundles/:id/retract', () => {
  it('lets the author retract and returns 409 the second time', async () => {
    const h = await start()
    const created = (await submitJson(h.port, TOKEN_A, { text: CLEAN, scheduledAt: FUTURE_LOCAL }))
      .json as { bundleId: string; entryId: string }

    const denied = await call(h.port, `/api/bundles/${created.bundleId}/retract`, {
      method: 'POST',
      token: TOKEN_B
    })
    expect(denied.status).toBe(403)

    const ok = await call(h.port, `/api/bundles/${created.bundleId}/retract`, {
      method: 'POST',
      token: TOKEN_A
    })
    expect(ok.status).toBe(200)
    const row = h.db
      .prepare('SELECT state FROM entries WHERE id = ?')
      .get(created.entryId) as { state: string }
    expect(row.state).toBe('retracted')

    const again = await call(h.port, `/api/bundles/${created.bundleId}/retract`, {
      method: 'POST',
      token: TOKEN_A
    })
    expect(again.status).toBe(409)
  })
})

describe('sessionCookie', () => {
  it('builds an HttpOnly Secure SameSite=Strict Path=/ cookie with a bounded Max-Age', () => {
    const header = sessionCookie('session-token')
    expect(header).toMatch(/^outbox=session-token;/)
    expect(header).toMatch(/Path=\//)
    expect(header).toMatch(/HttpOnly/)
    expect(header).toMatch(/Secure/)
    expect(header).toMatch(/SameSite=Strict/)
    const maxAge = Number(/Max-Age=(\d+)/.exec(header)?.[1])
    expect(maxAge).toBeGreaterThan(0)
    expect(maxAge).toBeLessThanOrEqual(86_400)
  })
})

describe('healthz probes', () => {
  it('reports ok true when the X probe is ok, the JWT secret is set, and the pack is present', async () => {
    const h = await start({ probeX: () => 'ok' })
    const health = await call(h.port, '/healthz')
    expect(health.status).toBe(200)
    expect(health.json).toMatchObject({
      ok: true,
      queueRunning: false,
      probes: { x: 'ok', jwt: 'ok' }
    })
  })

  it('reports ok false and probes.x bad when no X probe is wired', async () => {
    const h = await start()
    const health = await call(h.port, '/healthz')
    expect(health.status).toBe(200)
    expect(health.json).toMatchObject({
      ok: false,
      queueRunning: false,
      probes: { x: 'bad', jwt: 'ok' }
    })
  })

  it('reports ok false and probes.jwt bad when the JWT secret is unset', async () => {
    const h = await start({ probeX: () => 'ok', jwtSecret: '' })
    const health = await call(h.port, '/healthz')
    expect(health.status).toBe(200)
    expect(health.json).toMatchObject({
      ok: false,
      queueRunning: false,
      probes: { x: 'ok', jwt: 'bad' }
    })
  })

  it('reports ok false when the pack is missing and the other probes are ok', async () => {
    const h = await start({ pack: false, probeX: () => 'ok' })
    const health = await call(h.port, '/healthz')
    expect(health.status).toBe(200)
    expect(health.json).toEqual({
      ok: false,
      queueRunning: false,
      probes: { x: 'ok', jwt: 'ok' }
    })
  })

  it('reports the injected publisher running state', async () => {
    const h = await start({ probeX: () => 'ok', publisher: { running: () => true } })
    const health = await call(h.port, '/healthz')
    expect(health.json).toMatchObject({ queueRunning: true })
  })

  it('reports queueRunning false when an injected publisher is stopped', async () => {
    const h = await start({ probeX: () => 'ok', publisher: { running: () => false } })
    const health = await call(h.port, '/healthz')
    expect(health.json).toMatchObject({ queueRunning: false })
  })
})

describe('scheduled post recovery endpoints', () => {
  async function queued(h: Harness, status: 'failed' | 'uncertain') {
    const submitted = await submitJson(h.port, TOKEN_A, {
      text: CLEAN,
      scheduledAt: FUTURE_LOCAL
    })
    const created = submitted.json as { bundleId: string; entryId: string }
    const approved = await call(h.port, `/review/${created.bundleId}/decide`, {
      method: 'POST',
      token: TOKEN_ADMIN,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' })
    })
    expect(approved.status).toBe(200)
    const row = h.db.prepare(
      'SELECT id FROM scheduled_posts WHERE entryId = ?'
    ).get(created.entryId) as { id: string }
    h.db.prepare('UPDATE scheduled_posts SET status = ? WHERE id = ?').run(status, row.id)
    return row.id
  }

  it('restricts retry and resolve to ADMIN and returns conflict on a repeated transition', async () => {
    const h = await start()
    const failedId = await queued(h, 'failed')
    const denied = await call(
      h.port,
      `/api/posts/${failedId}/retry`,
      { method: 'POST', token: TOKEN_A }
    )
    expect(denied.status).toBe(403)
    const retried = await call(
      h.port,
      `/api/posts/${failedId}/retry`,
      { method: 'POST', token: TOKEN_ADMIN }
    )
    expect(retried.status).toBe(200)
    expect(retried.json).toEqual({ ok: true, status: 'pending' })
    expect((await call(
      h.port,
      `/api/posts/${failedId}/retry`,
      { method: 'POST', token: TOKEN_ADMIN }
    )).status).toBe(409)

    const uncertainId = await queued(h, 'uncertain')
    const resolveDenied = await call(
      h.port,
      `/api/posts/${uncertainId}/resolve-uncertain`,
      {
        method: 'POST',
        token: TOKEN_A,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ resolution: 'failed' })
      }
    )
    expect(resolveDenied.status).toBe(403)
    const resolved = await call(
      h.port,
      `/api/posts/${uncertainId}/resolve-uncertain`,
      {
        method: 'POST',
        token: TOKEN_ADMIN,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          resolution: 'sent',
          url: 'https://x.com/test_handle/status/1'
        })
      }
    )
    expect(resolved.status).toBe(200)
    expect(resolved.json).toEqual({ ok: true, status: 'sent' })
    expect((await call(
      h.port,
      `/api/posts/${uncertainId}/resolve-uncertain`,
      {
        method: 'POST',
        token: TOKEN_ADMIN,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ resolution: 'failed' })
      }
    )).status).toBe(409)
  })

  it('returns 404 for unknown retry and resolve post ids without changing the queue', async () => {
    const h = await start()
    await queued(h, 'uncertain')
    const before = h.db.prepare(
      'SELECT * FROM scheduled_posts ORDER BY id'
    ).all()
    const unknownId = 'missing-post-id'
    const retry = await call(
      h.port,
      `/api/posts/${unknownId}/retry`,
      { method: 'POST', token: TOKEN_ADMIN }
    )
    const resolve = await call(
      h.port,
      `/api/posts/${unknownId}/resolve-uncertain`,
      {
        method: 'POST',
        token: TOKEN_ADMIN,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ resolution: 'failed' })
      }
    )

    expect(retry.status).toBe(404)
    expect(resolve.status).toBe(404)
    expect(h.db.prepare(
      'SELECT * FROM scheduled_posts ORDER BY id'
    ).all()).toEqual(before)
  })

  it('rejects foreign URL hosts and cookie mutations from a foreign Origin', async () => {
    const h = await start()
    const uncertainId = await queued(h, 'uncertain')
    const badUrl = await call(
      h.port,
      `/api/posts/${uncertainId}/resolve-uncertain`,
      {
        method: 'POST',
        token: TOKEN_ADMIN,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          resolution: 'sent',
          url: 'https://x.com.evil.invalid/test/status/1'
        })
      }
    )
    expect(badUrl.status).toBe(400)
    const invalidUrls = [
      'https://x.com/settings/security',
      'https://x.com:444/a/status/1',
      'https://user@x.com/a/status/1',
      'https://user:password@x.com/a/status/1'
    ]
    for (const url of invalidUrls) {
      const rejected = await call(
        h.port,
        `/api/posts/${uncertainId}/resolve-uncertain`,
        {
          method: 'POST',
          token: TOKEN_ADMIN,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ resolution: 'sent', url })
        }
      )
      expect(rejected.status).toBe(400)
    }
    const acceptedSubdomain = await call(
      h.port,
      `/api/posts/${uncertainId}/resolve-uncertain`,
      {
        method: 'POST',
        token: TOKEN_ADMIN,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          resolution: 'sent',
          url: 'https://www.x.com/test/status/123?s=20'
        })
      }
    )
    expect(acceptedSubdomain.status).toBe(200)
    expect(
      h.db.prepare('SELECT url FROM scheduled_posts WHERE id = ?')
        .get(uncertainId)
    ).toEqual({ url: 'https://www.x.com/test/status/123' })
    const crossSite = await call(
      h.port,
      `/api/posts/${uncertainId}/resolve-uncertain`,
      {
        method: 'POST',
        origin: 'https://evil.invalid',
        headers: {
          'content-type': 'application/json',
          cookie: `outbox=${TOKEN_ADMIN}`
        },
        body: JSON.stringify({ resolution: 'failed' })
      }
    )
    expect(crossSite.status).toBe(403)
  })

  it('rejects HTTP post URLs without resolving the uncertain post', async () => {
    const h = await start()
    const uncertainId = await queued(h, 'uncertain')
    const response = await call(
      h.port,
      `/api/posts/${uncertainId}/resolve-uncertain`,
      {
        method: 'POST',
        token: TOKEN_ADMIN,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          resolution: 'sent',
          url: 'http://x.com/test/status/1'
        })
      }
    )

    expect(response.status).toBe(400)
    expect(
      h.db.prepare('SELECT status, url FROM scheduled_posts WHERE id = ?')
        .get(uncertainId)
    ).toEqual({ status: 'uncertain', url: null })
  })

  it('allows resolving an uncertain post as sent without a URL', async () => {
    const h = await start()
    const postId = await queued(h, 'uncertain')
    const resolved = await call(
      h.port,
      `/api/posts/${postId}/resolve-uncertain`,
      {
        method: 'POST',
        token: TOKEN_ADMIN,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ resolution: 'sent' })
      }
    )
    expect(resolved.status).toBe(200)
    expect(resolved.json).toEqual({ ok: true, status: 'sent' })
    expect(
      h.db.prepare('SELECT url FROM scheduled_posts WHERE id = ?').get(postId)
    ).toEqual({ url: null })
  })

  it('allows resolving an uncertain post as sent with an empty form URL', async () => {
    const h = await start()
    const postId = await queued(h, 'uncertain')
    const resolved = await call(
      h.port,
      `/api/posts/${postId}/resolve-uncertain`,
      {
        method: 'POST',
        token: TOKEN_ADMIN,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'resolution=sent&url='
      }
    )

    expect(resolved.status).toBe(200)
    expect(resolved.text).toContain('Post status: sent.')
    expect(
      h.db.prepare('SELECT status, url FROM scheduled_posts WHERE id = ?').get(postId)
    ).toEqual({ status: 'sent', url: null })
  })

  it('allows resolving an uncertain post as failed with an empty form URL', async () => {
    const h = await start()
    const postId = await queued(h, 'uncertain')
    const resolved = await call(
      h.port,
      `/api/posts/${postId}/resolve-uncertain`,
      {
        method: 'POST',
        token: TOKEN_ADMIN,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'resolution=failed&url='
      }
    )

    expect(resolved.status).toBe(200)
    expect(resolved.text).toContain('Post status: failed.')
    expect(
      h.db.prepare('SELECT status, url FROM scheduled_posts WHERE id = ?').get(postId)
    ).toEqual({ status: 'failed', url: null })
  })

  it('returns HTML for retry and resolve form submissions', async () => {
    const h = await start()
    const failedId = await queued(h, 'failed')
    const retry = await call(h.port, `/api/posts/${failedId}/retry`, {
      method: 'POST',
      token: TOKEN_ADMIN,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: ''
    })
    expect(retry.status).toBe(200)
    expect(retry.headers.get('content-type')).toContain('text/html')
    expect(retry.text).toContain('Post status: pending.')

    const uncertainId = await queued(h, 'uncertain')
    const resolve = await call(
      h.port,
      `/api/posts/${uncertainId}/resolve-uncertain`,
      {
        method: 'POST',
        token: TOKEN_ADMIN,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ resolution: 'failed' }).toString()
      }
    )
    expect(resolve.status).toBe(200)
    expect(resolve.headers.get('content-type')).toContain('text/html')
    expect(resolve.text).toContain('Post status: failed.')
  })

  it('shows channel state and admin recovery forms while GET leaves queue and audit unchanged', async () => {
    const h = await start()
    const postId = await queued(h, 'uncertain')
    const snapshot = () => ({
      posts: h.db.prepare('SELECT * FROM scheduled_posts ORDER BY id').all(),
      audit: h.db.prepare('SELECT * FROM audit ORDER BY id').all()
    })
    const before = snapshot()
    const list = await call(h.port, '/api/posts', { token: TOKEN_ADMIN })
    expect(list.text).toContain(
      `"channel":{"postId":"${postId}","channel":"x","status":"uncertain"`
    )
    const bundle = h.db.prepare(
      `SELECT e.bundleId FROM scheduled_posts p
       JOIN entries e ON e.id = p.entryId WHERE p.id = ?`
    ).get(postId) as { bundleId: string }
    const page = await call(h.port, `/review/${bundle.bundleId}`, { token: TOKEN_ADMIN })
    expect(page.text).toContain('Mark as sent')
    expect(page.text).toContain('Mark as failed')
    const composer = await call(h.port, `/review/${bundle.bundleId}`, { token: TOKEN_A })
    expect(composer.text).not.toContain('Mark as sent')
    expect(composer.text).not.toContain('Mark as failed')
    expect(snapshot()).toEqual(before)
  })

  it('creates scheduled posts only through the approve route', async () => {
    const h = await start()
    const countPosts = () => (
      h.db.prepare('SELECT COUNT(*) AS n FROM scheduled_posts').get() as {
        n: number
      }
    ).n

    const submitted = await submitJson(h.port, TOKEN_ADMIN, {
      text: CLEAN,
      scheduledAt: FUTURE_LOCAL
    })
    const submission = submitted.json as { bundleId: string }
    expect(countPosts()).toBe(0)

    const reviewed = await call(h.port, '/api/review', {
      method: 'POST',
      token: TOKEN_ADMIN,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: CLEAN })
    })
    expect(reviewed.status).toBe(200)
    expect(countPosts()).toBe(0)

    const retracted = await call(
      h.port,
      `/api/bundles/${submission.bundleId}/retract`,
      { method: 'POST', token: TOKEN_ADMIN }
    )
    expect(retracted.status).toBe(200)
    expect(countPosts()).toBe(0)

    const approvable = await submitJson(h.port, TOKEN_ADMIN, {
      text: CLEAN,
      scheduledAt: FUTURE_LOCAL
    })
    const entry = approvable.json as { bundleId: string; entryId: string }
    const decision = await call(
      h.port,
      `/review/${entry.bundleId}/decide`,
      {
        method: 'POST',
        token: TOKEN_ADMIN,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'approve' })
      }
    )
    expect(decision.status).toBe(200)
    expect(countPosts()).toBe(1)
    const post = h.db.prepare(
      'SELECT id FROM scheduled_posts WHERE entryId = ?'
    ).get(entry.entryId) as { id: string }

    h.db.prepare("UPDATE scheduled_posts SET status = 'failed' WHERE id = ?")
      .run(post.id)
    const retried = await call(
      h.port,
      `/api/posts/${post.id}/retry`,
      { method: 'POST', token: TOKEN_ADMIN }
    )
    expect(retried.status).toBe(200)
    expect(countPosts()).toBe(1)

    h.db.prepare("UPDATE scheduled_posts SET status = 'uncertain' WHERE id = ?")
      .run(post.id)
    const resolved = await call(
      h.port,
      `/api/posts/${post.id}/resolve-uncertain`,
      {
        method: 'POST',
        token: TOKEN_ADMIN,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ resolution: 'failed' })
      }
    )
    expect(resolved.status).toBe(200)
    expect(countPosts()).toBe(1)
  })
})

describe('GET /api/me', () => {
  it('returns account, user, and role from the identity', async () => {
    const h = await start()
    const res = await call(h.port, '/api/me', { token: TOKEN_A })
    expect(res.status).toBe(200)
    expect(res.json).toEqual({
      account: 'account-a',
      user: 'user-a',
      role: 'OUTBOX'
    })
  })
})

describe('GET /posts', () => {
  it('shows only the author’s posts to OUTBOX and every post to ADMIN', async () => {
    const h = await start()
    const own = submitSubmission(h.db, { text: 'own author post', scheduledAt: SUMMER_EPOCH, checks: { blocking: [] }, actor: { user: 'user-a', account: 'account-a' }, now: NOW })
    const other = submitSubmission(h.db, { text: 'other author post', scheduledAt: SUMMER_EPOCH + 300_000, checks: { blocking: [] }, actor: { user: 'user-b', account: 'account-b' }, now: NOW })
    expect(own.ok && other.ok).toBe(true)
    const author = await call(h.port, '/posts', { token: TOKEN_A })
    expect(author.status).toBe(200)
    expect(author.text).toContain('own author post')
    expect(author.text).not.toContain('other author post')
    expect(author.text).toContain('Waiting for approval.')
    expect(author.text).toContain('aria-current="page">Posts')
    const admin = await call(h.port, '/posts', { token: TOKEN_ADMIN })
    expect(admin.text).toContain('own author post')
    expect(admin.text).toContain('other author post')
    expect(admin.text.indexOf('other author post')).toBeLessThan(admin.text.indexOf('own author post'))
    const api = await call(h.port, '/api/posts', { token: TOKEN_ADMIN })
    const posts = (api.json as { posts: Array<{ text: string; scheduledAt: number }> }).posts
    expect(posts.map((post) => post.text)).toEqual(['own author post', 'other author post'])
    expect(posts.map((post) => post.scheduledAt)).toEqual([SUMMER_EPOCH, SUMMER_EPOCH + 300_000])
  })

  it('shows the correct empty state for authors and approvers', async () => {
    const h = await start()
    const author = await call(h.port, '/posts', { token: TOKEN_A })
    const admin = await call(h.port, '/posts', { token: TOKEN_ADMIN })
    expect(author.text).toContain('No posts yet.')
    expect(author.text).toContain('Write a post')
    expect(admin.text).toContain('No posts yet.')
    expect(admin.text).not.toContain('Write a post')
  })
})

describe('GET /media/:sha256', () => {
  it('serves image bytes only to an identity that can see a referencing entry', async () => {
    const h = await start()
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1])
    const created = submitSubmission(h.db, { text: CLEAN, scheduledAt: SUMMER_EPOCH, imageBytes: bytes, checks: { blocking: [] }, actor: { user: 'user-a', account: 'account-a' }, now: NOW })
    if (!created.ok) throw new Error('expected submission')
    const sha = imageSha256(bytes)
    const author = await fetch(`http://127.0.0.1:${h.port}/media/${sha}`, { headers: { authorization: `Bearer ${TOKEN_A}` } })
    expect(author.status).toBe(200)
    expect(Buffer.from(await author.arrayBuffer()).equals(bytes)).toBe(true)
    expect(author.headers.get('content-type')).toBe('image/png')
    expect(author.headers.get('x-content-type-options')).toBe('nosniff')
    expect(author.headers.get('cache-control')).toBe('private, no-store')
    const other = await call(h.port, `/media/${sha}`, { token: TOKEN_B })
    const unknown = await call(h.port, `/media/${'0'.repeat(64)}`, { token: TOKEN_A })
    expect(other.status).toBe(404)
    expect(unknown.status).toBe(404)
  })
})

describe('POST /api/review', () => {
  it('returns findings and writes no entry', async () => {
    const h = await start()
    const res = await call(h.port, '/api/review', {
      method: 'POST',
      token: TOKEN_A,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: BLOCKING })
    })
    expect(res.status).toBe(200)
    expect(res.json).toEqual({
      ok: true,
      blocking: ['Forbidden claim: trustless'],
      hints: [],
      charCount: [...BLOCKING].length,
      costHint: 'X pay-per-use: 0.015 USD per post, 0.200 USD if the post contains a URL.'
    })
    expect(entryCount(h.db)).toBe(0)
  })

  it('returns the empty draft counters and no findings for the blank composer state', async () => {
    const h = await start()
    const res = await call(h.port, '/api/review', {
      method: 'POST', token: TOKEN_A,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '' })
    })
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({
      ok: true,
      blocking: [],
      hints: [],
      charCount: 0,
      costHint: 'X pay-per-use: 0.015 USD per post, 0.200 USD if the post contains a URL.'
    })
  })
})

describe('unreadable cookie', () => {
  it('returns 401 rather than 500 when the session cookie cannot be decoded', async () => {
    const h = await start()
    const res = await call(h.port, '/', {
      headers: { cookie: 'outbox=%' }
    })
    expect(res.status).toBe(401)
    expect(res.text).not.toContain('Internal error.')
  })
})

describe('review check presentation', () => {
  it('does not show a Checked scope line on the composer', async () => {
    const h = await start()
    const page = await call(h.port, '/', { token: TOKEN_A })
    expect(page.text).toContain('Checks appear here as you type.')
    expect(page.text).not.toContain('Checked:')
  })
})

describe('font assets', () => {
  it('serves discovered woff2 files publicly with immutable caching and security headers', async () => {
    const h = await start()
    const response = await fetch(`http://127.0.0.1:${h.port}/assets/fonts/Inter-Regular.woff2`)
    const bytes = Buffer.from(await response.arrayBuffer())

    expect(response.status).toBe(200)
    expect(bytes.equals(readFileSync(join(FONT_DIRECTORY, 'Inter-Regular.woff2')))).toBe(true)
    expect(response.headers.get('content-type')).toBe('font/woff2')
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(response.headers.get('content-security-policy')).toContain("font-src 'self'")
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'")
  })

  it('returns 404 for unknown, traversing, encoded-slash, non-woff2, and license files', async () => {
    const h = await start()
    for (const name of ['missing.woff2', '..%2fserver.ts', 'Inter-Regular.ttf', 'Inter-LICENSE.txt']) {
      const response = await fetch(`http://127.0.0.1:${h.port}/assets/fonts/${name}`)
      expect(response.status).toBe(404)
    }
  })

  it('references the served Inter regular font from the composer page', async () => {
    const h = await start()
    const response = await call(h.port, '/', { token: TOKEN_A })
    expect(response.status).toBe(200)
    expect(response.text).toContain('@font-face')
    expect(response.text).toContain('/assets/fonts/Inter-Regular.woff2')
  })
})

describe('composer script and CSP', () => {
  it('serves only the composer script asset and permits it through the exact CSP', async () => {
    const h = await start()
    const page = await call(h.port, '/', { token: TOKEN_A })
    expect(page.headers.get('content-security-policy')).toBe("default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'self' blob:; style-src 'unsafe-inline'; font-src 'self'; form-action 'self'; base-uri 'none'")
    const script = await fetch(`http://127.0.0.1:${h.port}/assets/composer.js`)
    expect(script.status).toBe(200)
    expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8')
    expect(await script.text()).toBe(readFileSync(join(dirname(FONT_DIRECTORY), 'composer.js'), 'utf8'))
    expect((await fetch(`http://127.0.0.1:${h.port}/assets/private.js`)).status).toBe(404)
  })
})
