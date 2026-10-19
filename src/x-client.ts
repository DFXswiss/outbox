import { createHash } from 'node:crypto'
import type { SqliteDatabase } from './db'
import type { PublishResult } from './status'

type Credentials = {
  accessToken: string | null
  accessTokenExpiresAt: number | null
  refreshToken: string
  seedHash: string
  updatedAt: number
}
export type XClientOptions = {
  db: SqliteDatabase
  clientId: string
  clientSecret?: string
  handle: string
  apiBase?: string
  fetch?: typeof fetch
  now?: () => number
}

function immediate<T>(db: SqliteDatabase, fn: () => T): T {
  return db.transaction(fn).immediate()
}

export function loadCredentials(db: SqliteDatabase): Credentials | null {
  return (
    db.prepare(
      `SELECT accessToken, accessTokenExpiresAt, refreshToken, seedHash, updatedAt
       FROM x_credentials WHERE id = 1`
    ).get() as Credentials | undefined
  ) ?? null
}

export function saveCredentials(db: SqliteDatabase, value: Credentials): void {
  immediate(db, () => {
    db.prepare(
      `INSERT INTO x_credentials (
         id, accessToken, accessTokenExpiresAt, refreshToken, seedHash, updatedAt
       ) VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         accessToken = excluded.accessToken,
         accessTokenExpiresAt = excluded.accessTokenExpiresAt,
         refreshToken = excluded.refreshToken,
         seedHash = excluded.seedHash,
         updatedAt = excluded.updatedAt`
    ).run(
      value.accessToken,
      value.accessTokenExpiresAt,
      value.refreshToken,
      value.seedHash,
      value.updatedAt
    )
  })
}

export function seedCredentials(
  db: SqliteDatabase,
  refreshToken: string,
  now = Date.now()
): void {
  const seedHash = createHash('sha256').update(refreshToken).digest('hex')
  immediate(db, () => {
    const existing = db.prepare(
      'SELECT seedHash FROM x_credentials WHERE id = 1'
    ).get() as { seedHash: string } | undefined
    if (existing?.seedHash === seedHash) {
      return
    }
    db.prepare(
      `INSERT INTO x_credentials (
         id, accessToken, accessTokenExpiresAt, refreshToken, seedHash, updatedAt
       ) VALUES (1, NULL, NULL, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         accessToken = NULL,
         accessTokenExpiresAt = NULL,
         refreshToken = excluded.refreshToken,
         seedHash = excluded.seedHash,
         updatedAt = excluded.updatedAt`
    ).run(refreshToken, seedHash, now)
  })
}

function errorDetail(
  status: number,
  body: unknown,
  secrets: string[] = []
): string {
  const values: string[] = [`HTTP ${status}`]
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const record = body as Record<string, unknown>
    for (const key of ['title', 'detail']) {
      if (typeof record[key] === 'string') {
        values.push(record[key] as string)
      }
    }
    if (values.length === 1 && Array.isArray(record.errors)) {
      for (const item of record.errors.slice(0, 3)) {
        if (typeof item === 'string') {
          values.push(item)
          continue
        }
        if (item && typeof item === 'object') {
          const error = item as Record<string, unknown>
          for (const key of ['title', 'detail', 'message']) {
            if (typeof error[key] === 'string') {
              values.push(error[key] as string)
            }
          }
        }
      }
    }
  }
  let detail = values.join(': ').replace(/[\r\n\t]+/g, ' ')
  for (const secret of secrets) {
    if (secret) {
      detail = detail.split(secret).join('[redacted]')
    }
  }
  return detail.slice(0, 300)
}

function safeError(error: unknown): string {
  if (error instanceof Error && /^HTTP \d{3}(?::|$)/.test(error.message)) {
    return error.message.slice(0, 300)
  }
  if (error instanceof Error && /deadline|timeout|abort/i.test(error.message)) {
    return 'Request deadline exceeded'
  }
  return 'Network request failed'
}

export function createXClient(options: XClientOptions) {
  const fetchImpl = options.fetch ?? fetch
  const now = options.now ?? (() => Date.now())
  const root = (options.apiBase ?? 'https://api.x.com').replace(/\/$/, '')
  let refreshFlight: Promise<string> | null = null

  async function request(
    url: string,
    init: RequestInit,
    deadlineMs: number,
    onDispatch?: () => void
  ): Promise<Response> {
    const remaining = deadlineMs - now()
    if (remaining <= 0) {
      throw new Error('Deadline exceeded')
    }
    const requestInit: RequestInit = {
      ...init,
      redirect: 'manual',
      signal: AbortSignal.timeout(remaining)
    }
    onDispatch?.()
    return fetchImpl(url, requestInit)
  }

  async function refresh(deadlineMs: number): Promise<string> {
    if (refreshFlight) {
      return refreshFlight
    }
    refreshFlight = (async () => {
      const current = loadCredentials(options.db)
      if (!current) {
        throw new Error('Refresh credentials unavailable')
      }
      const form = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: current.refreshToken,
        client_id: options.clientId
      })
      const headers: Record<string, string> = {
        'content-type': 'application/x-www-form-urlencoded'
      }
      if (options.clientSecret !== undefined && options.clientSecret !== '') {
        headers.authorization = `Basic ${Buffer.from(
          `${options.clientId}:${options.clientSecret}`
        ).toString('base64')}`
      }
      const response = await request(
        `${root}/2/oauth2/token`,
        { method: 'POST', headers, body: form.toString() },
        deadlineMs
      )
      let body: unknown
      try {
        body = await response.json()
      } catch {
        body = null
      }
      if (
        !response.ok ||
        !body ||
        typeof body !== 'object' ||
        typeof (body as Record<string, unknown>).access_token !== 'string' ||
        (body as Record<string, unknown>).access_token === ''
      ) {
        throw new Error(errorDetail(response.status, body, [
          current.accessToken ?? '',
          current.refreshToken
        ]))
      }
      const record = body as Record<string, unknown>
      const accessToken = record.access_token as string
      const rotated = typeof record.refresh_token === 'string' && record.refresh_token !== ''
        ? record.refresh_token
        : current.refreshToken
      const expiry = typeof record.expires_in === 'number'
        ? now() + record.expires_in * 1000
        : now() + 7_200_000
      saveCredentials(options.db, {
        ...current,
        accessToken,
        accessTokenExpiresAt: expiry,
        refreshToken: rotated,
        updatedAt: now()
      })
      return accessToken
    })()
    try {
      return await refreshFlight
    } finally {
      refreshFlight = null
    }
  }

  async function ensureAccessToken(deadlineMs: number): Promise<string> {
    const current = loadCredentials(options.db)
    if (
      current?.accessToken &&
      current.accessTokenExpiresAt !== null &&
      current.accessTokenExpiresAt - now() >= 60_000
    ) {
      return current.accessToken
    }
    return refresh(deadlineMs)
  }

  async function probe(): Promise<'ok' | 'bad'> {
    const deadline = now() + 15_000
    try {
      let token = await ensureAccessToken(deadline)
      let response = await request(
        `${root}/2/users/me`,
        { headers: { authorization: `Bearer ${token}` } },
        deadline
      )
      if (response.status === 401) {
        token = await refresh(deadline)
        response = await request(
          `${root}/2/users/me`,
          { headers: { authorization: `Bearer ${token}` } },
          deadline
        )
      }
      if (!response.ok) {
        return 'bad'
      }
      const body: unknown = await response.json()
      if (!body || typeof body !== 'object') {
        return 'bad'
      }
      const data = (body as Record<string, unknown>).data
      if (
        !data ||
        typeof data !== 'object' ||
        typeof (data as Record<string, unknown>).username !== 'string'
      ) {
        return 'bad'
      }
      const clean = (value: string) =>
        value.replace(/^@/, '').toLocaleLowerCase('en-US')
      return clean((data as Record<string, unknown>).username as string) ===
        clean(options.handle)
        ? 'ok'
        : 'bad'
    } catch {
      return 'bad'
    }
  }

  async function postTweet(
    text: string,
    deadlineMs: number
  ): Promise<{ result: PublishResult; needsLogin: boolean }> {
    let token: string
    try {
      token = await ensureAccessToken(deadlineMs)
    } catch (error) {
      return {
        result: { channel: 'x', ok: false, error: safeError(error) },
        needsLogin: true
      }
    }

    let postStarted = false
    const dispatch = async (accessToken: string): Promise<Response> => {
      if (deadlineMs <= now()) {
        throw new Error('Deadline exceeded before dispatch')
      }
      return request(
        `${root}/2/tweets`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${accessToken}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({ text })
        },
        deadlineMs,
        () => {
          postStarted = true
        }
      )
    }
    let response: Response
    try {
      response = await dispatch(token)
    } catch (error) {
      return {
        result: {
          channel: 'x',
          ok: false,
          ...(postStarted ? { uncertain: true } : {}),
          error: safeError(error)
        },
        needsLogin: false
      }
    }

    if (response.status === 401) {
      try {
        token = await refresh(deadlineMs)
      } catch (error) {
        return {
          result: {
            channel: 'x',
            ok: false,
            uncertain: true,
            error: safeError(error)
          },
          needsLogin: true
        }
      }
      try {
        response = await dispatch(token)
      } catch (error) {
        return {
          result: {
            channel: 'x',
            ok: false,
            uncertain: true,
            error: safeError(error)
          },
          needsLogin: false
        }
      }
    }
    let body: unknown
    try {
      body = await response.json()
    } catch {
      body = null
    }
    if (response.status === 200 || response.status === 201) {
      const data = body && typeof body === 'object' ? (body as Record<string, unknown>).data : null
      const id = data && typeof data === 'object' ? (data as Record<string, unknown>).id : null
      if (typeof id !== 'string' || id === '') {
        return {
          result: {
            channel: 'x',
            ok: false,
            uncertain: true,
            error: errorDetail(response.status, body, [
              token,
              loadCredentials(options.db)?.refreshToken ?? ''
            ])
          },
          needsLogin: false
        }
      }
      const handle = options.handle.replace(/^@/, '')
      return {
        result: {
          channel: 'x',
          ok: true,
          url: `https://x.com/${encodeURIComponent(handle)}/status/${encodeURIComponent(id)}`
        },
        needsLogin: false
      }
    }
    const error = errorDetail(response.status, body, [
      token,
      loadCredentials(options.db)?.refreshToken ?? ''
    ])
    if (
      (response.status >= 300 && response.status < 400) ||
      response.status >= 500 ||
      (response.status >= 200 && response.status < 300)
    ) {
      return {
        result: { channel: 'x', ok: false, uncertain: true, error },
        needsLogin: false
      }
    }
    if (response.status === 401) {
      return { result: { channel: 'x', ok: false, error }, needsLogin: true }
    }
    return { result: { channel: 'x', ok: false, error }, needsLogin: false }
  }

  return { probe, postTweet, ensureAccessToken }
}
