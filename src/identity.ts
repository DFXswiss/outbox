import { createHmac, timingSafeEqual } from 'node:crypto'

export type Role = 'OUTBOX' | 'ADMIN'

export type Identity = {
  user: number
  account: number
  role: Role
}

/**
 * DFX hierarchy, not recursive. ADMIN fulfills OUTBOX; OUTBOX does not
 * fulfill ADMIN. Backend SuperAdmin is mapped to ADMIN before this sees it.
 */
export function hasRoleAccess(needed: Role, actual: Role): boolean {
  if (actual === needed) return true
  if (needed === 'OUTBOX' && actual === 'ADMIN') return true
  return false
}

export type IntrospectResult = ({ ok: true } & Identity) | { ok: false; status: number; reason?: 'tfa-required' | 'staff-kyc-required' | 'forbidden' }

/**
 * Identity seam. Callers (the HTTP surface) never talk to a network;
 * tests replace this with a fixed implementation.
 */
export type Introspect = (token: string, role: Role) => Promise<IntrospectResult>

export function decodeJwtHs256(
  token: string,
  secret: string
): { address: unknown; user: unknown; account: unknown; role?: unknown; exp: unknown; tfaRequired: unknown } | null {
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
  return { address: rec.address, user: rec.user, account: rec.account, role: rec.role, exp: rec.exp, tfaRequired: rec.tfaRequired }
}

export function validJwtClaims(claims: ReturnType<typeof decodeJwtHs256>, now = Date.now()): boolean {
  return claims !== null && typeof claims.address === 'string' && claims.address.trim() !== '' &&
    positiveId(claims.user) && positiveId(claims.account) &&
    typeof claims.exp === 'number' && Number.isFinite(claims.exp) && claims.exp * 1000 > now
}

function positiveId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function roleFromPayload(value: unknown): Role | null {
  if (value === 'Outbox') return 'OUTBOX'
  if (value === 'Admin' || value === 'SuperAdmin') return 'ADMIN'
  return null
}

export type HttpIntrospectOptions = {
  baseUrl: string
  jwtSecret?: string
  fetch?: typeof fetch
  timeoutMs?: number
}

/**
 * The one network adapter for identity. Calls
 * `GET /v1/auth/introspect/outbox` or `/admin` with `Authorization: Bearer`.
 * Tests inject fetch so they exercise this adapter without reaching a network.
 */
export function createHttpIntrospect(options: HttpIntrospectOptions): Introspect {
  const root = options.baseUrl.replace(/\/$/, '')
  const fetchImpl = options.fetch ?? fetch
  return async (token, role) => {
    let verifiedClaims: ReturnType<typeof decodeJwtHs256> = null
    if (options.jwtSecret !== undefined && options.jwtSecret !== '') {
      const claims = decodeJwtHs256(token, options.jwtSecret)
      if (!validJwtClaims(claims)) {
        return { ok: false, status: 401 }
      }
      verifiedClaims = claims
    }

    const path =
      role === 'ADMIN' ? '/v1/auth/introspect/admin' : '/v1/auth/introspect/outbox'
    let response: { status: number; json: () => Promise<unknown> }
    try {
      response = await fetchImpl(`${root}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        redirect: 'manual',
        signal: AbortSignal.timeout(options.timeoutMs ?? 5_000)
      })
    } catch {
      return { ok: false, status: 502 }
    }
    if (response.status !== 200) {
      if (response.status === 403) {
        let body: unknown
        try { body = await response.json() } catch { body = null }
        const code = body && typeof body === 'object' ? (body as Record<string, unknown>).code : undefined
        return { ok: false, status: 403, reason: code === 'TFA_REQUIRED' ? 'tfa-required' : code === 'STAFF_KYC_REQUIRED' ? 'staff-kyc-required' : 'forbidden' }
      }
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
    if (!positiveId(rec.user) || !positiveId(rec.account)) {
      return { ok: false, status: 502 }
    }
    if (
      verifiedClaims !== null &&
      (rec.user !== verifiedClaims.user || rec.account !== verifiedClaims.account)
    ) {
      // A signed request and a conflicting upstream identity are a bad gateway response, not denial.
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
