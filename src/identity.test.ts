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
})
