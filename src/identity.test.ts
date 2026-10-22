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

const claims = {
  address: 'wallet-address',
  user: 'user-1',
  account: 'account-1',
  role: 'OUTBOX'
}

describe('createHttpIntrospect', () => {
  it('returns the identity when the response agrees with the verified claims', async () => {
    const fetch = vi.fn(async () => response(claims))
    const introspect = createHttpIntrospect({
      baseUrl: 'https://identity.invalid',
      jwtSecret: secret,
      fetch
    })

    await expect(introspect(token(claims), 'OUTBOX')).resolves.toEqual({
      ok: true,
      user: 'user-1',
      account: 'account-1',
      role: 'OUTBOX'
    })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('maps SUPER_ADMIN to ADMIN', async () => {
    const fetch = vi.fn(async () => response({
      user: 'user-1',
      account: 'account-1',
      role: 'SUPER_ADMIN'
    }))
    const introspect = createHttpIntrospect({
      baseUrl: 'https://identity.invalid',
      jwtSecret: secret,
      fetch
    })

    await expect(introspect(token(claims), 'ADMIN')).resolves.toEqual({
      ok: true,
      user: 'user-1',
      account: 'account-1',
      role: 'ADMIN'
    })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('rejects a response with an account different from the verified claim', async () => {
    const fetch = vi.fn(async () => response({ ...claims, account: 'account-2' }))
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
    const fetch = vi.fn(async () => response({ ...claims, user: 'user-2' }))
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
    const fetch = vi.fn(async () => response(claims))
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
    const fetch = vi.fn(async () => response(claims))
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
