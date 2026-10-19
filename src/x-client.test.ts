import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, type SqliteDatabase } from './db'
import { createXClient, loadCredentials, seedCredentials } from './x-client'

const NOW = 1_700_000_000_000
let dir: string
let db: SqliteDatabase
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'outbox-x-'))
  db = openDatabase(join(dir, 'db.sqlite'))
  seedCredentials(db, 'test-refresh-token', NOW)
  db.prepare(
    "UPDATE x_credentials SET accessToken = 'test-access-token', " +
      'accessTokenExpiresAt = ? WHERE id = 1'
  ).run(NOW + 7_200_000)
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

function client(fetch: typeof globalThis.fetch, options: { secret?: string; now?: () => number } = {}) {
  return createXClient({
    db,
    clientId: 'test-client',
    ...(options.secret ? { clientSecret: options.secret } : {}),
    handle: '@test_handle',
    apiBase: 'https://x.invalid',
    fetch,
    now: options.now ?? (() => NOW)
  })
}

describe('X publisher client', () => {
  it('publishes a 201 response as an X permalink', async () => {
    const x = client(async () => json({ data: { id: '123', text: 'hello' } }, 201))
    await expect(x.postTweet('hello', NOW + 20_000)).resolves.toEqual({
      result: {
        channel: 'x',
        ok: true,
        url: 'https://x.com/test_handle/status/123'
      },
      needsLogin: false
    })
  })

  it.each([400, 403, 429])('classifies HTTP %s as failed', async (status) => {
    const x = client(async () => json({
      title: 'Rejected',
      detail: 'invalid post'
    }, status))
    const response = await x.postTweet('hello', NOW + 20_000)
    expect(response.result).toMatchObject({
      ok: false,
      channel: 'x',
      error: `HTTP ${status}: Rejected: invalid post`
    })
    expect(response.result.uncertain).toBeUndefined()
  })

  it('classifies a server error and a network failure after dispatch as uncertain', async () => {
    const server = client(async () => json({ title: 'Unavailable' }, 503))
    expect((await server.postTweet('hello', NOW + 20_000)).result)
      .toMatchObject({ uncertain: true, error: 'HTTP 503: Unavailable' })
    let dispatched = 0
    const network = client(async () => {
      dispatched += 1
      throw new Error('socket failed')
    })
    expect((await network.postTweet('hello', NOW + 20_000)).result).toMatchObject({ uncertain: true })
    expect(dispatched).toBe(1)
  })

  it('does not dispatch after the deadline and redacts tokens from X error details', async () => {
    let requests = 0
    let clockCalls = 0
    const expired = client(async () => {
      requests += 1
      return json({ data: { id: '1' } }, 201)
    }, {
      now: () => {
        clockCalls += 1
        return clockCalls === 1 ? NOW : NOW + 20_000
      }
    })
    const expiredResult = await expired.postTweet('hello', NOW + 20_000)
    expect(expiredResult.result.ok).toBe(false)
    expect(expiredResult.result.uncertain).not.toBe(true)
    expect('uncertain' in expiredResult.result).toBe(false)
    expect(requests).toBe(0)

    let deadlineClock = NOW
    const aborted = client(async (_input, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      deadlineClock = NOW + 1_001
      throw new DOMException('The operation was aborted', 'AbortError')
    }, {
      now: () => deadlineClock
    })
    expect((await aborted.postTweet('hello', NOW + 1_000)).result).toMatchObject({
      ok: false,
      uncertain: true,
      error: 'Request deadline exceeded'
    })

    const x = client(async () => json({
      title: 'test-access-token',
      detail: 'test-refresh-token was rejected'
    }, 403))
    const result = await x.postTweet('hello', NOW + 20_000)
    expect(result.result.error).toContain('HTTP 403')
    expect(result.result.error).not.toContain('test-access-token')
    expect(result.result.error).not.toContain('test-refresh-token')
  })

  it('does not send when the deadline expires before fetch is called', async () => {
    let clockCalls = 0
    let tweetRequests = 0
    const x = client(async (input) => {
      if (String(input).endsWith('/2/tweets')) {
        tweetRequests += 1
      }
      return json({ data: { id: '1' } }, 201)
    }, {
      now: () => {
        clockCalls += 1
        return clockCalls <= 2 ? NOW : NOW + 20_000
      }
    })

    const response = await x.postTweet('hello', NOW + 20_000)

    expect(response.result.ok).toBe(false)
    expect(response.result.uncertain).not.toBe(true)
    expect('uncertain' in response.result).toBe(false)
    expect(tweetRequests).toBe(0)
  })

  it('treats a successful HTTP response without an id as uncertain', async () => {
    const x = client(async () => json({ data: { text: 'accepted?' } }, 201))
    expect((await x.postTweet('hello', NOW + 20_000)).result)
      .toMatchObject({ ok: false, uncertain: true })
  })

  it('refreshes once after 401, persists rotation before posting, and sends Basic auth only with a secret', async () => {
    const requests: Array<{ url: string; authorization: string | null }> = []
    let tweets = 0
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = String(input)
      const headers = new Headers(init?.headers)
      requests.push({ url, authorization: headers.get('authorization') })
      if (url.endsWith('/2/oauth2/token')) {
        expect(headers.get('authorization')).toMatch(/^Basic /)
        return json({
          access_token: 'refreshed-access-token',
          refresh_token: 'rotated-refresh-token',
          expires_in: 7200
        })
      }
      tweets += 1
      if (tweets === 1) {
        return json({ title: 'expired' }, 401)
      }
      expect(loadCredentials(db)?.refreshToken).toBe('rotated-refresh-token')
      return json({ data: { id: '456' } }, 201)
    }
    const x = client(fetch, { secret: 'test-client-secret' })
    await expect(x.postTweet('hello', NOW + 20_000)).resolves.toMatchObject({
      result: {
        ok: true,
        url: 'https://x.com/test_handle/status/456'
      }
    })
    expect(requests.map((request) => request.url)).toEqual([
      'https://x.invalid/2/tweets',
      'https://x.invalid/2/oauth2/token',
      'https://x.invalid/2/tweets'
    ])
    expect(requests.filter((request) => request.url.endsWith('/2/tweets'))
      .map((request) => request.authorization)).toEqual([
      'Bearer test-access-token',
      'Bearer refreshed-access-token'
    ])
  })

  it('does exactly one refresh after dispatch and classifies failed refresh as uncertain with needs-login', async () => {
    let tweets = 0
    let tokens = 0
    const x = client(async (input) => {
      if (String(input).endsWith('/2/oauth2/token')) {
        tokens += 1
        return json({ title: 'invalid refresh' }, 400)
      }
      tweets += 1
      return json({ title: 'expired' }, 401)
    })
    expect(await x.postTweet('hello', NOW + 20_000)).toMatchObject({
      result: { ok: false, uncertain: true },
      needsLogin: true
    })
    expect({ tweets, tokens }).toEqual({ tweets: 1, tokens: 1 })
  })

  it('does not refresh twice when the retried post also returns 401', async () => {
    let tweets = 0
    let tokens = 0
    const x = client(async (input) => {
      if (String(input).endsWith('/2/oauth2/token')) {
        tokens += 1
        return json({ access_token: 'test-access-token', expires_in: 7200 })
      }
      tweets += 1
      return json({ title: 'unauthorized' }, 401)
    })
    const response = await x.postTweet('hello', NOW + 20_000)
    expect(response.result.ok).toBe(false)
    expect(response.result.uncertain).not.toBe(true)
    expect('uncertain' in response.result).toBe(false)
    expect(response.needsLogin).toBe(true)
    expect({ tweets, tokens }).toEqual({ tweets: 2, tokens: 1 })
  })

  it('does not dispatch a tweet when pre-dispatch refresh fails and coalesces simultaneous refreshes', async () => {
    db.prepare('UPDATE x_credentials SET accessTokenExpiresAt = NULL WHERE id = 1').run()
    let tweets = 0
    const failed = client(async (input) => {
      if (String(input).endsWith('/2/tweets')) {
        tweets += 1
      }
      return json({ title: 'refresh rejected' }, 400)
    })
    const response = await failed.postTweet('hello', NOW + 20_000)
    expect(response.result.ok).toBe(false)
    expect(response.result.uncertain).not.toBe(true)
    expect('uncertain' in response.result).toBe(false)
    expect(response.needsLogin).toBe(true)
    expect(tweets).toBe(0)

    let tokenRequests = 0
    db.prepare('UPDATE x_credentials SET accessTokenExpiresAt = NULL WHERE id = 1').run()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const shared = client(async () => {
      tokenRequests += 1
      await gate
      return json({ access_token: 'shared-access-token', expires_in: 7200 })
    })
    const first = shared.ensureAccessToken(NOW + 20_000)
    const second = shared.ensureAccessToken(NOW + 20_000)
    release()
    await expect(Promise.all([first, second])).resolves.toEqual([
      'shared-access-token',
      'shared-access-token'
    ])
    expect(tokenRequests).toBe(1)
  })

  it('uses no Basic header without a client secret', async () => {
    db.prepare('UPDATE x_credentials SET accessTokenExpiresAt = NULL WHERE id = 1').run()
    let authorization: string | null = null
    const x = client(async (_input, init) => {
      authorization = new Headers(init?.headers).get('authorization')
      return json({ access_token: 'test-access-token', expires_in: 7200 })
    })
    await x.ensureAccessToken(NOW + 20_000)
    expect(authorization).toBeNull()
  })

  it('keeps the existing refresh token when a successful rotation omits a replacement', async () => {
    db.prepare('UPDATE x_credentials SET accessTokenExpiresAt = NULL WHERE id = 1').run()
    const x = client(async () => json({
      access_token: 'new-test-access-token',
      expires_in: 7200
    }))
    await x.ensureAccessToken(NOW + 20_000)
    expect(loadCredentials(db)?.refreshToken).toBe('test-refresh-token')
  })

  it('does not expose tokens in errors and honors an unchanged seed without undoing rotation', () => {
    db.prepare("UPDATE x_credentials SET refreshToken = 'rotated-refresh-token' WHERE id = 1").run()
    seedCredentials(db, 'test-refresh-token', NOW + 1)
    expect(loadCredentials(db)?.refreshToken).toBe('rotated-refresh-token')
    seedCredentials(db, 'replacement-refresh-token', NOW + 2)
    expect(loadCredentials(db)).toMatchObject({
      refreshToken: 'replacement-refresh-token',
      accessToken: null,
      accessTokenExpiresAt: null
    })
  })

  it('matches X usernames after removing one leading @ and reports mismatches as bad', async () => {
    const matching = client(async () => json({ data: { username: '@test_handle' } }))
    expect(await matching.probe()).toBe('ok')
    const mismatch = client(async () => json({ data: { username: 'someone-else' } }))
    expect(await mismatch.probe()).toBe('bad')
    const failing = client(async () => {
      throw new Error('offline')
    })
    expect(await failing.probe()).toBe('bad')
  })

  it('refreshes once after a 401 during the identity probe', async () => {
    const requests: string[] = []
    const x = client(async (input) => {
      const url = String(input)
      requests.push(url)
      if (
        url.endsWith('/2/users/me') &&
        requests.filter((item) => item.endsWith('/2/users/me')).length === 1
      ) {
        return json({}, 401)
      }
      if (url.endsWith('/2/oauth2/token')) {
        return json({
          access_token: 'refreshed-test-access-token',
          expires_in: 7200
        })
      }
      return json({ data: { username: 'test_handle' } })
    })
    expect(await x.probe()).toBe('ok')
    expect(requests).toHaveLength(3)
    expect(requests.filter((url) => url.endsWith('/2/oauth2/token'))).toHaveLength(1)
  })
})
