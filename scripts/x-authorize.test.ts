import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { authorize, validState } from './x-authorize'

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
        // Shape: https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code
        return Response.json({
          token_type: 'bearer',
          expires_in: 7200,
          access_token: 'access-secret',
          scope: 'tweet.read tweet.write users.read offline.access',
          refresh_token: 'refresh-secret'
        })
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
      // Shape: https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code
      ? Response.json({
        token_type: 'bearer',
        expires_in: 7200,
        access_token: 'access-secret',
        scope: 'tweet.read tweet.write users.read offline.access',
        refresh_token: 'refresh-secret'
      })
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
})
