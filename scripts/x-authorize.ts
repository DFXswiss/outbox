import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const REDIRECT = 'http://127.0.0.1:8765/callback'
const SCOPES = 'tweet.read tweet.write users.read offline.access media.write'

type AuthorizeOptions = {
  envPath: string
  fetch?: typeof fetch
  output?: (line: string) => void
  receiveCode?: (url: string, state: string) => Promise<string>
}

export function validState(received: string, expected: string): boolean {
  const a = Buffer.from(received)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

function readEnvironment(path: string): { content: string; clientId: string; clientSecret: string; handle: string } {
  if ((statSync(path).mode & 0o777) !== 0o600) throw new Error('Env file must have mode 600.')
  const content = readFileSync(path, 'utf8')
  const values = new Map<string, string>()
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*(X_CLIENT_ID|X_CLIENT_SECRET|X_HANDLE)\s*=\s*(.*?)\s*$/.exec(line)
    if (match) values.set(match[1]!, match[2]!.replace(/^(["'])(.*)\1$/, '$2'))
  }
  const clientId = values.get('X_CLIENT_ID') ?? ''
  const clientSecret = values.get('X_CLIENT_SECRET') ?? ''
  const handle = (values.get('X_HANDLE') ?? '').replace(/^@/, '')
  if (!clientId || !clientSecret || !/^[A-Za-z0-9_]{1,15}$/.test(handle)) throw new Error('Missing or invalid X authorization configuration.')
  return { content, clientId, clientSecret, handle }
}

async function receiveBrowserCode(url: string, state: string, output: (line: string) => void): Promise<string> {
  return new Promise((resolveCode, reject) => {
    const server = createServer((req, res) => {
      const callback = new URL(req.url ?? '/', REDIRECT)
      if (callback.pathname !== '/callback') { res.writeHead(404); res.end(); return }
      const received = callback.searchParams.get('state') ?? ''
      if (!validState(received, state)) {
        res.writeHead(400); res.end('Authorization failed.'); finish(new Error('Authorization state mismatch.')); return
      }
      const code = callback.searchParams.get('code')
      if (!code) { res.writeHead(400); res.end('Authorization failed.'); finish(new Error('Authorization failed.')); return }
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Authorization received. You can close this window.')
      finish(undefined, code)
    })
    const timer = setTimeout(() => finish(new Error('Authorization timed out.')), 300_000)
    function finish(error?: Error, code?: string) {
      clearTimeout(timer)
      server.close()
      if (error) reject(error)
      else resolveCode(code!)
    }
    server.once('error', () => finish(new Error('Could not start the callback server.')))
    server.listen(8765, '127.0.0.1', () => {
      output(url)
      if (process.platform === 'darwin') {
        const child = spawn('open', [url], { stdio: 'ignore' })
        child.on('error', () => {})
        child.unref()
      }
    })
  })
}

export async function authorize(options: AuthorizeOptions): Promise<void> {
  const { content, clientId, clientSecret, handle } = readEnvironment(options.envPath)
  const fetchImpl = options.fetch ?? fetch
  const output = options.output ?? ((line: string) => process.stdout.write(`${line}\n`))
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const state = randomBytes(32).toString('base64url')
  const url = new URL('https://x.com/i/oauth2/authorize')
  url.search = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, scope: SCOPES, state, code_challenge: challenge, code_challenge_method: 'S256' }).toString()
  const code = await (options.receiveCode ?? ((link, expected) => receiveBrowserCode(link, expected, output)))(url.toString(), state)
  const tokenResponse = await fetchImpl('https://api.x.com/2/oauth2/token', {
    method: 'POST',
    headers: { authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: clientId }).toString(),
    redirect: 'manual', signal: AbortSignal.timeout(30_000)
  })
  if (tokenResponse.status !== 200) throw new Error('X token exchange failed.')
  const tokens = await tokenResponse.json() as { access_token?: unknown; refresh_token?: unknown }
  if (typeof tokens.access_token !== 'string' || !tokens.access_token || typeof tokens.refresh_token !== 'string' || !tokens.refresh_token || /[\r\n]/.test(tokens.refresh_token)) throw new Error('X returned an invalid token response.')
  const userResponse = await fetchImpl('https://api.x.com/2/users/me', { headers: { authorization: `Bearer ${tokens.access_token}` }, redirect: 'manual', signal: AbortSignal.timeout(30_000) })
  if (userResponse.status !== 200) throw new Error('X account lookup failed.')
  const user = await userResponse.json() as { data?: { username?: unknown } }
  if (typeof user.data?.username !== 'string' || user.data.username.toLowerCase() !== handle.toLowerCase()) throw new Error('X account does not match X_HANDLE.')
  const lines = content.split(/\r?\n/).filter((line) => !/^\s*X_REFRESH_TOKEN\s*=/.test(line))
  while (lines.length && lines[lines.length - 1] === '') lines.pop()
  lines.push(`X_REFRESH_TOKEN=${tokens.refresh_token}`)
  writeFileSync(options.envPath, `${lines.join('\n')}\n`, { mode: 0o600 })
  chmodSync(options.envPath, 0o600)
  output(`Refresh token stored for @${handle}.`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  const envPath = args.length === 0 ? join(homedir(), '.config/outbox-e2e/x.env') : args.length === 2 && args[0] === '--env' ? args[1]! : ''
  if (!envPath) {
    process.stderr.write('Usage: npm run x:authorize -- [--env path]\n')
    process.exitCode = 1
  } else {
    authorize({ envPath }).catch(() => {
      process.stderr.write('X authorization failed. Check the configuration and try again.\n')
      process.exitCode = 1
    })
  }
}
