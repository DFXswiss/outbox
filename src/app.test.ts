import { createHmac } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildApp } from './app'
import { loadConfig } from './config'
import { openDatabase } from './db'
import { seedCredentials } from './x-client'

const BRAND = 'dfx'
const TEST_JWT_SECRET = 'test-app-jwt-secret'

function signedToken(
  claims: Record<string, unknown>,
  signingSecret = TEST_JWT_SECRET
): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
    .toString('base64url')
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const signature = createHmac('sha256', signingSecret)
    .update(`${header}.${payload}`)
    .digest('base64url')
  return `${header}.${payload}.${signature}`
}

function fakeFetch(): typeof fetch {
  return async (input) => {
    const url = new URL(String(input))
    if (url.pathname === '/2/oauth2/token') {
      return new Response(JSON.stringify({
        access_token: 'test-access-token',
        refresh_token: 'rotated-test-refresh-token',
        expires_in: 7200,
        token_type: 'bearer',
        scope: 'tweet.read tweet.write users.read'
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
    if (url.pathname === '/2/users/me') {
      return new Response(JSON.stringify({
        data: {
          id: 'test-user-id',
          name: 'Test User',
          username: 'test_handle'
        }
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }
    return new Response('{}', { status: 404 })
  }
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('Expected a TCP address'))
        return
      }
      resolve(address.port)
    })
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    })
  })
}

async function healthFor(
  packRootPath: (root: string) => string,
  brand = BRAND,
  packBrand = brand,
  captureBeforeStart = false
): Promise<unknown> {
  const root = mkdtempSync(join(tmpdir(), 'outbox-app-'))
  const rulesDirectory = join(root, 'content', packBrand)
  mkdirSync(rulesDirectory, { recursive: true })
  writeFileSync(
    join(rulesDirectory, 'rules.json'),
    JSON.stringify({
      topic: packBrand,
      forbiddenClaims: [],
      micarUnsafe: [],
      provisionalParameters: []
    })
  )

  const configResult = loadConfig({
    DB_PATH: join(root, 'outbox.sqlite'),
    PACK_ROOT: packRootPath(root),
    BRAND: brand,
    DFX_API_BASE_URL: 'https://identity.invalid',
    JWT_SECRET: 'test-jwt-secret',
    X_CLIENT_ID: 'test-client-id',
    X_REFRESH_TOKEN: 'test-refresh-token',
    X_HANDLE: 'test_handle',
    X_API_BASE: 'https://x.invalid'
  } as NodeJS.ProcessEnv)
  if (!configResult.ok) {
    rmSync(root, { recursive: true, force: true })
    throw new Error(`Invalid test configuration: ${configResult.variables.join(', ')}`)
  }

  const db = openDatabase(configResult.config.dbPath)
  seedCredentials(db, configResult.config.xRefreshToken!)
  const { server, publisher } = buildApp(configResult.config, {
    db,
    fetch: fakeFetch()
  })
  try {
    const port = await listen(server)
    let before: unknown
    if (captureBeforeStart) {
      const initialResponse = await fetch(`http://127.0.0.1:${port}/healthz`)
      expect(initialResponse.status).toBe(200)
      before = await initialResponse.json()
    }
    await publisher.start()
    const response = await fetch(`http://127.0.0.1:${port}/healthz`)
    expect(response.status).toBe(200)
    const after = await response.json()
    return captureBeforeStart ? { before, after } : after
  } finally {
    try {
      await publisher.stop()
    } finally {
      try {
        if (server.listening) {
          await close(server)
        }
      } finally {
        db.close()
        rmSync(root, { recursive: true, force: true })
      }
    }
  }
}

describe('buildApp pack root', () => {
  it('loads rules from content/<brand> below PACK_ROOT', async () => {
    const health = await healthFor((root) => root)
    expect(health).toMatchObject({
      ok: true,
      probes: { x: 'ok', jwt: 'ok' }
    })
  })

  it('does not load rules when PACK_ROOT points at content itself', async () => {
    const health = await healthFor((root) => join(root, 'content'))
    expect(health).toMatchObject({
      ok: false,
      probes: { x: 'ok', jwt: 'ok' }
    })
  })

  it('loads the pack for a configured non-default brand', async () => {
    const health = await healthFor((root) => root, 'gifts', 'gifts')
    expect(health).toMatchObject({
      ok: true,
      probes: { x: 'ok', jwt: 'ok' }
    })
  })

  it('does not fall back to the default brand when the configured pack is absent', async () => {
    const health = await healthFor((root) => root, 'gifts', 'dfx')
    expect(health).toMatchObject({
      ok: false,
      probes: { x: 'ok', jwt: 'ok' }
    })
  })
})

describe('buildApp identity verification', () => {
  it('verifies signed token claims before introspection', async () => {
    const root = mkdtempSync(join(tmpdir(), 'outbox-app-identity-'))
    const configResult = loadConfig({
      DB_PATH: join(root, 'outbox.sqlite'),
      PACK_ROOT: root,
      BRAND,
      DFX_API_BASE_URL: 'https://identity.invalid',
      JWT_SECRET: TEST_JWT_SECRET,
      X_CLIENT_ID: 'test-client-id',
      X_HANDLE: 'test_handle',
      X_API_BASE: 'https://x.invalid'
    } as NodeJS.ProcessEnv)
    if (!configResult.ok) {
      rmSync(root, { recursive: true, force: true })
      throw new Error(`Invalid test configuration: ${configResult.variables.join(', ')}`)
    }

    const db = openDatabase(configResult.config.dbPath)
    let introspectionCalls = 0
    const upstreamFetch: typeof globalThis.fetch = async (input) => {
      const path = new URL(String(input)).pathname
      if (path.startsWith('/v1/auth/introspect/')) {
        introspectionCalls += 1
        return new Response(JSON.stringify({
          user: 'verified-user',
          account: 'verified-account',
          role: 'OUTBOX'
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }
      return new Response('{}', { status: 404 })
    }
    const { server, publisher } = buildApp(configResult.config, {
      db,
      fetch: upstreamFetch
    })

    try {
      const port = await listen(server)
      const wrongSecretToken = signedToken({
        address: 'test-address',
        user: 'verified-user',
        account: 'verified-account',
        role: 'OUTBOX'
      }, 'different-test-secret')
      const invalidAddressToken = signedToken({
        user: 'verified-user',
        account: 'verified-account',
        role: 'OUTBOX'
      })
      for (const token of [wrongSecretToken, invalidAddressToken]) {
        const rejected = await globalThis.fetch(`http://127.0.0.1:${port}/api/me`, {
          headers: { authorization: `Bearer ${token}` }
        })
        expect(rejected.status).toBe(401)
      }
      expect(introspectionCalls).toBe(0)

      const validToken = signedToken({
        address: 'test-address',
        user: 'verified-user',
        account: 'verified-account',
        role: 'OUTBOX'
      })
      const accepted = await globalThis.fetch(`http://127.0.0.1:${port}/api/me`, {
        headers: { authorization: `Bearer ${validToken}` }
      })
      expect(accepted.status).toBe(200)
      expect(introspectionCalls).toBe(1)
    } finally {
      try {
        await publisher.stop()
      } finally {
        try {
          if (server.listening) {
            await close(server)
          }
        } finally {
          db.close()
          rmSync(root, { recursive: true, force: true })
        }
      }
    }
  })
})

describe('publisher probe state', () => {
  it('starts bad and becomes healthy and running after a successful probe', async () => {
    const result = await healthFor((root) => root, BRAND, BRAND, true) as {
      before: unknown
      after: unknown
    }
    expect(result.before).toMatchObject({
      ok: false,
      queueRunning: false,
      probes: { x: 'bad' }
    })
    expect(result.after).toMatchObject({
      ok: true,
      queueRunning: true,
      probes: { x: 'ok', jwt: 'ok' }
    })
  })
})
