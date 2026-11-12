import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { authorize, startAuthorizationCallback, validState } from './x-authorize'

// Form, token_type, expires_in and scope from a real X refresh response on 2026-11-10; access_token and refresh_token are placeholders because real tokens do not belong in the repository.
const TOKEN_RESPONSE = {
  token_type: 'bearer',
  expires_in: 7200,
  access_token: 'access-secret',
  scope: 'offline.access tweet.write media.write users.read tweet.read',
  refresh_token: 'refresh-secret'
}

const directories: string[] = []
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function fixture(mode = 0o600) {
  const dir = mkdtempSync(join(tmpdir(), 'x-authorize-'))
  directories.push(dir)
  const envPath = join(dir, 'x.env')
  writeFileSync(envPath, 'X_CLIENT_ID=client\nX_CLIENT_SECRET=secret\nX_HANDLE=Example\nX_REFRESH_TOKEN=old\n', { mode })
  chmodSync(envPath, mode)
  return envPath
}

describe('X authorization', () => {
  it('uses S256 PKCE, replaces the token, and never prints credentials', async () => {
    const envPath = fixture()
    const output: string[] = []
    let challenge = ''
    const fetchStub: typeof fetch = async (input, init) => {
      if (String(input).endsWith('/oauth2/token')) {
        const verifier = new URLSearchParams(String(init?.body)).get('code_verifier')!
        expect(createHash('sha256').update(verifier).digest('base64url')).toBe(challenge)
        return Response.json(TOKEN_RESPONSE)
      }
      // Shape: https://docs.x.com/x-api/users/get-my-user
      return Response.json({ data: { id: '1', name: 'Example', username: 'example' } })
    }
    await authorize({ envPath, fetch: fetchStub, output: (line) => output.push(line), receiveCode: async (url, state) => {
      const parsed = new URL(url)
      challenge = parsed.searchParams.get('code_challenge')!
      expect(parsed.searchParams.get('code_challenge_method')).toBe('S256')
      expect(parsed.searchParams.get('state')).toBe(state)
      return 'code'
    } })
    const contents = readFileSync(envPath, 'utf8')
    expect(contents.match(/^X_REFRESH_TOKEN=/gm)).toHaveLength(1)
    expect(contents).toContain('X_REFRESH_TOKEN=refresh-secret')
    expect(statSync(envPath).mode & 0o777).toBe(0o600)
    expect(output.join('\n')).not.toMatch(/access-secret|refresh-secret/)
  })

  it('does not write when the account differs', async () => {
    const envPath = fixture()
    const before = readFileSync(envPath, 'utf8')
    const fetchStub: typeof fetch = async (input) => String(input).endsWith('/oauth2/token')
      ? Response.json(TOKEN_RESPONSE)
      // Shape: https://docs.x.com/x-api/users/get-my-user
      : Response.json({ data: { id: '1', name: 'Different', username: 'different' } })
    await expect(authorize({ envPath, fetch: fetchStub, receiveCode: async () => 'code' })).rejects.toThrow('does not match')
    expect(readFileSync(envPath, 'utf8')).toBe(before)
  })

  it('rejects an env file with an unsafe mode before starting authorization', async () => {
    const envPath = fixture(0o644)
    await expect(authorize({ envPath, receiveCode: async () => { throw new Error('unexpected') } })).rejects.toThrow('mode 600')
  })

  it('rejects mismatched callback states', () => {
    expect(validState('state', 'state')).toBe(true)
    expect(validState('state', 'other')).toBe(false)
    expect(validState('', 'state')).toBe(false)
  })

  it('does not write when X omits a required scope', async () => {
    const envPath = fixture()
    const before = readFileSync(envPath, 'utf8')
    const fetchStub: typeof fetch = async (input) => String(input).endsWith('/oauth2/token')
      ? Response.json({ ...TOKEN_RESPONSE, scope: 'offline.access tweet.write users.read tweet.read' })
      : Response.json({ data: { id: '1', name: 'Example', username: 'example' } })
    await expect(authorize({ envPath, fetch: fetchStub, receiveCode: async () => 'code' })).rejects.toThrow('X did not grant: media.write')
    expect(readFileSync(envPath, 'utf8')).toBe(before)
  })

  it('answers a wrong state with 400 and still accepts the right callback', async () => {
    const session = await startAuthorizationCallback('expected-state')
    try {
      const wrong = await fetch(`http://127.0.0.1:${session.port}/callback?state=other-state&code=nope`)
      expect(wrong.status).toBe(400)
      expect(await wrong.text()).toBe('Authorization failed.')
      const right = await fetch(`http://127.0.0.1:${session.port}/callback?state=expected-state&code=granted-code`)
      expect(right.status).toBe(200)
      await expect(session.result).resolves.toBe('granted-code')
    } finally {
      await session.close()
    }
  })

  it('cancels an open authorization before any callback', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const session = await startAuthorizationCallback('expected-state')
      try {
        const pending = session.result
        const timers = vi.getTimerCount()
        expect(timers).toBeGreaterThan(0)
        await session.close()
        await new Promise((resolve) => setImmediate(resolve))
        expect(unhandled).toEqual([])
        await expect(pending).rejects.toThrow('Authorization cancelled.')
        expect(vi.getTimerCount()).toBe(timers - 1)
        vi.useRealTimers()
        await expect(fetch(`http://127.0.0.1:${session.port}/callback?state=expected-state&code=later`)).rejects.toThrow()
      } finally {
        await session.close()
      }
    } finally {
      vi.useRealTimers()
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
