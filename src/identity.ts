import { createHmac, timingSafeEqual } from 'node:crypto'

export type Role = 'OUTBOX' | 'ADMIN'

export type Identity = {
  user: string
  account: string
  role: Role
}

export type IntrospectResult = ({ ok: true } & Identity) | { ok: false; status: number }

/**
 * Identity seam. Callers (the HTTP surface) never talk to a network;
 * tests replace this with a fixed implementation.
 */
export type Introspect = (token: string, role: Role) => Promise<IntrospectResult>

function decodeJwtHs256(
  token: string,
  secret: string
): { address: unknown; user: unknown; account: unknown; role?: unknown } | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [headerB64, payloadB64, sigB64] = parts
  let header: unknown
  try {
    header = JSON.parse(Buffer.from(headerB64!, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (header === null || typeof header !== 'object' || Array.isArray(header)) return null
  if ((header as { alg?: unknown }).alg !== 'HS256') return null

  const expected = createHmac('sha256', secret).update(`${headerB64}.${payloadB64}`).digest()
  let actual: Buffer
  try {
    actual = Buffer.from(sigB64!, 'base64url')
  } catch {
    return null
  }
  if (actual.length !== expected.length) return null
  if (!timingSafeEqual(actual, expected)) return null

  let payload: unknown
  try {
    payload = JSON.parse(Buffer.from(payloadB64!, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null
  const rec = payload as Record<string, unknown>
  return { address: rec.address, user: rec.user, account: rec.account, role: rec.role }
}

function roleFromPayload(value: unknown): Role | null {
  if (value === 'OUTBOX') return 'OUTBOX'
  if (value === 'ADMIN' || value === 'SUPER_ADMIN') return 'ADMIN'
  return null
}

export type HttpIntrospectOptions = {
  baseUrl: string
  jwtSecret?: string
}

/**
 * The one network adapter for identity. Calls
 * `GET /v1/auth/introspect/outbox` or `/admin` with `Authorization: Bearer`.
 * Untested here on purpose: tests inject a fixed `Introspect` and must not
 * reach a network.
 */
export function createHttpIntrospect(options: HttpIntrospectOptions): Introspect {
  const root = options.baseUrl.replace(/\/$/, '')
  return async (token, role) => {
    if (options.jwtSecret !== undefined && options.jwtSecret !== '') {
      const claims = decodeJwtHs256(token, options.jwtSecret)
      if (
        claims === null ||
        typeof claims.address !== 'string' ||
        claims.address === '' ||
        typeof claims.user !== 'string' ||
        claims.user === '' ||
        typeof claims.account !== 'string' ||
        claims.account === ''
      ) {
        return { ok: false, status: 401 }
      }
    }

    const path =
      role === 'ADMIN' ? '/v1/auth/introspect/admin' : '/v1/auth/introspect/outbox'
    let response: { status: number; json: () => Promise<unknown> }
    try {
      response = await fetch(`${root}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        redirect: 'manual'
      })
    } catch {
      return { ok: false, status: 502 }
    }
    if (response.status !== 200) {
      return { ok: false, status: response.status === 0 ? 502 : response.status }
    }

    let body: unknown
    try {
      body = await response.json()
    } catch {
      return { ok: false, status: 502 }
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return { ok: false, status: 502 }
    }
    const rec = body as Record<string, unknown>
    if (typeof rec.user !== 'string' || typeof rec.account !== 'string') {
      return { ok: false, status: 502 }
    }
    const roleName = roleFromPayload(rec.role)
    if (roleName === null) return { ok: false, status: 502 }
    return {
      ok: true,
      user: rec.user,
      account: rec.account,
      role: roleName
    }
  }
}
