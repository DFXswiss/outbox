import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createHttpIntrospect } from './identity'

const secret = 'test-only-secret'

function token(claims: Record<string, unknown>, signingSecret = secret): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const signature = createHmac('sha256', signingSecret)
    .update(`${header}.${payload}`)
    .digest('base64url')
  return `${header}.${payload}.${signature}`
}

function response(body: unknown): Response {
  return { status: 200, json: async () => body } as Response
}

// Shape: the DFX API, src/shared/auth/jwt-payload.interface.ts
const claims = {
  address: 'wallet-address',
  user: 1,
  account: 1,
  role: 'Outbox',
  exp: 4_102_444_800
}
// Shape: the DFX API, GET /v1/auth/introspect/outbox contract
const introspectionBody = { user: 1, account: 1, role: 'Outbox' }

describe('createHttpIntrospect', () => {
  it.each([undefined, 0, 1, -1, 1.5, '1'])('rejects missing, expired, or invalid exp %s before fetch', async (exp) => {
    const fetch = vi.fn(async () => response(introspectionBody))
    const introspect = createHttpIntrospect({ baseUrl: 'https://identity.invalid', jwtSecret: secret, fetch })
    await expect(introspect(token({ ...claims, exp }), 'OUTBOX')).resolves.toMatchObject({ ok: false, status: 401 })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([0, -1, 1.5, '1', null])('rejects non-positive or non-integer JWT identity %s', async (user) => {
    const fetch = vi.fn(async () => response(introspectionBody))
    const introspect = createHttpIntrospect({ baseUrl: 'https://identity.invalid', jwtSecret: secret, fetch })
    await expect(introspect(token({ ...claims, user }), 'OUTBOX')).resolves.toMatchObject({ ok: false, status: 401 })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['OUTBOX', 'ADMIN', 'SUPER_ADMIN', 'Marketing'])('rejects backend role %s', async (role) => {
    // Shape: the DFX API, src/shared/auth/user-role.enum.ts
    const introspect = createHttpIntrospect({ baseUrl: 'https://identity.invalid', fetch: async () => response({ user: 1, account: 1, role }) })
    await expect(introspect('token', 'OUTBOX')).resolves.toEqual({ ok: false, status: 502 })
  })

  it.each([
    [{ code: 'TFA_REQUIRED', message: '2FA required (strict)', level: 'strict' }, 'tfa-required'],
    [{ code: 'STAFF_KYC_REQUIRED', message: 'Staff access requires a verified name on your account' }, 'staff-kyc-required'],
    [{ statusCode: 403, message: 'Forbidden resource', error: 'Forbidden' }, 'forbidden'],
    [{ statusCode: 403, message: 'Mail login required', error: 'Forbidden' }, 'forbidden']
  ])('classifies a 403 backend body %s', async (body, reason) => {
    // Captured from a locally running DFX API (ENVIRONMENT=loc) on 2026-11-09
    const introspect = createHttpIntrospect({ baseUrl: 'https://identity.invalid', fetch: async () => new Response(JSON.stringify(body), { status: 403 }) })
    await expect(introspect('token', 'OUTBOX')).resolves.toEqual({ ok: false, status: 403, reason })
  })
  it('returns the identity when the response agrees with the verified claims', async () => {
    const fetch = vi.fn(async () => response(introspectionBody))
    const introspect = createHttpIntrospect({
      baseUrl: 'https://identity.invalid',
      jwtSecret: secret,
      fetch
    })

    await expect(introspect(token(claims), 'OUTBOX')).resolves.toEqual({
      ok: true,
      user: 1,
      account: 1,
      role: 'OUTBOX'
    })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('maps SuperAdmin to ADMIN', async () => {
    // Shape: the DFX API, src/shared/auth/user-role.enum.ts
    const fetch = vi.fn(async () => response({
      user: 1,
      account: 1,
      role: 'SuperAdmin'
    }))
    const introspect = createHttpIntrospect({
      baseUrl: 'https://identity.invalid',
      jwtSecret: secret,
      fetch
    })

    await expect(introspect(token(claims), 'ADMIN')).resolves.toEqual({
      ok: true,
      user: 1,
      account: 1,
      role: 'ADMIN'
    })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('rejects a response with an account different from the verified claim', async () => {
    const fetch = vi.fn(async () => response({ ...introspectionBody, account: 2 }))
    const introspect = createHttpIntrospect({
      baseUrl: 'https://identity.invalid',
      jwtSecret: secret,
      fetch
    })

    await expect(introspect(token(claims), 'OUTBOX')).resolves.toEqual({
      ok: false,
      status: 502
    })
  })

  it('rejects a response with a user different from the verified claim', async () => {
    const fetch = vi.fn(async () => response({ ...introspectionBody, user: 2 }))
    const introspect = createHttpIntrospect({
      baseUrl: 'https://identity.invalid',
      jwtSecret: secret,
      fetch
    })

    await expect(introspect(token(claims), 'OUTBOX')).resolves.toEqual({
      ok: false,
      status: 502
    })
  })

  it('rejects an invalid signature before making the HTTP request', async () => {
    const fetch = vi.fn(async () => response(introspectionBody))
    const introspect = createHttpIntrospect({
      baseUrl: 'https://identity.invalid',
      jwtSecret: secret,
      fetch
    })

    await expect(introspect(token(claims, 'wrong-secret'), 'OUTBOX')).resolves.toEqual({
      ok: false,
      status: 401
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    { field: 'address', value: 'missing' },
    { field: 'address', value: 'empty' },
    { field: 'user', value: 'missing' },
    { field: 'user', value: 'empty' },
    { field: 'account', value: 'missing' },
    { field: 'account', value: 'empty' }
  ])('rejects a signed token with $value $field before fetch', async ({ field, value }) => {
    const invalidClaims: Record<string, unknown> = { ...claims }
    if (value === 'missing') {
      delete invalidClaims[field]
    } else {
      invalidClaims[field] = ''
    }
    const fetch = vi.fn(async () => response(introspectionBody))
    const introspect = createHttpIntrospect({
      baseUrl: 'https://identity.invalid',
      jwtSecret: secret,
      fetch
    })

    await expect(introspect(token(invalidClaims), 'OUTBOX')).resolves.toEqual({
      ok: false,
      status: 401
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('returns 502 when introspection is aborted by its deadline', async () => {
    let capturedSignal: AbortSignal | null = null
    const fetch: typeof globalThis.fetch = async (_input, init) => {
      const signal = init?.signal
      if (!signal) {
        throw new Error('expected an abort signal')
      }
      capturedSignal = signal
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(signal.reason)
        if (signal.aborted) {
          abort()
        } else {
          signal.addEventListener('abort', abort, { once: true })
        }
      })
    }
    const introspect = createHttpIntrospect({
      baseUrl: 'https://identity.invalid',
      fetch,
      timeoutMs: 1
    })

    await expect(introspect('test-token', 'OUTBOX')).resolves.toEqual({
      ok: false,
      status: 502
    })
    expect(capturedSignal).toBeInstanceOf(AbortSignal)
  })
})
