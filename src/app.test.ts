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

async function healthFor(packRootPath: (root: string) => string): Promise<unknown> {
  const root = mkdtempSync(join(tmpdir(), 'outbox-app-'))
  const rulesDirectory = join(root, 'content', BRAND)
  mkdirSync(rulesDirectory, { recursive: true })
  writeFileSync(
    join(rulesDirectory, 'rules.json'),
    JSON.stringify({
      topic: BRAND,
      forbiddenClaims: [],
      micarUnsafe: [],
      provisionalParameters: []
    })
  )

  const configResult = loadConfig({
    DB_PATH: join(root, 'outbox.sqlite'),
    PACK_ROOT: packRootPath(root),
    BRAND,
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
    await publisher.start()
    const response = await fetch(`http://127.0.0.1:${port}/healthz`)
    expect(response.status).toBe(200)
    return await response.json()
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
})
