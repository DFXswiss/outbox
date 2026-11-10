import { randomBytes } from 'node:crypto'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { deflateSync } from 'node:zlib'
import Database from 'better-sqlite3'
import { HDNodeWallet, Wallet } from 'ethers'
import { findMailOtp, parseEnv, readPrivateEnv, redactKnownSecrets, saveRefreshToken, scheduledSlot, totp, unexpectedPostStatus } from './helpers'
import { createXProxy } from './x-proxy'
import { cleanupTimelinePosts, findTimelinePosts } from './timeline'

type Result = 'pass' | 'fail' | 'not-run'
type Station = { name: string; result: Result; detail: string }
type Post = { bundleId: string; state: string; decisionComment: string | null; channel: { postId: string; status: string; url: string | null } | null }
class NotRun extends Error {}
class E2eFailure extends Error {}
const stations: Station[] = []
const secrets = new Set<string>()
const publicUrls: string[] = []
const tweets = new Set<string>()
const deletedTweets = new Set<string>()
const start = new Date().toISOString()
let exitCode = 0
let active = 'preconditions'
let temp = ''
let child: ChildProcess | undefined
let proxy: ReturnType<typeof createXProxy> | undefined
let dbPath = ''
let logPath = ''
let xPath = ''
let hasX = false
let xHandle = ''
let lastAccess = ''
let base = ''
let authorCookie = ''
let backendDir = ''
const runId = randomBytes(8).toString('hex')
const textA = `Outbox E2E ${runId} text`
const textB = `Outbox E2E ${runId} image`
const textD = `Outbox E2E ${runId} response loss`

function fail(detail: string): never { throw new E2eFailure(detail) }
function check(condition: unknown, detail: string): asserts condition { if (!condition) fail(detail) }
function secret(value: string): string { if (value) secrets.add(value); return value }
function git(args: string[], cwd: string): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) return 'unavailable'
  return result.stdout.trim()
}
function record(name: string, result: Result, detail: string): void { stations.push({ name, result, detail }) }
async function station(name: string, work: () => Promise<void>): Promise<void> {
  active = name
  await work()
  record(name, 'pass', 'Completed')
}
function jsonResponse(response: Response): Promise<Record<string, any>> { return response.json() as Promise<Record<string, any>> }
async function http(url: string, expected: number, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(30_000) })
  check(response.status === expected, `${active}: expected HTTP ${expected}, got ${response.status}`)
  return response
}
function cookie(response: Response, name: string): string {
  const values = response.headers.getSetCookie()
  const found = values.find((value) => value.startsWith(`${name}=`))
  check(found, `${active}: missing ${name} cookie`)
  const part = found.split(';')[0]!
  if (name === 'outbox') secret(decodeURIComponent(part.slice(name.length + 1)))
  return part
}
function headers(session: string): Record<string, string> { return { cookie: session, origin: base, accept: 'application/json' } }
async function postJson(path: string, session: string, body: unknown, expected = 200): Promise<Record<string, any>> {
  return jsonResponse(await http(`${base}${path}`, expected, { method: 'POST', headers: { ...headers(session), 'content-type': 'application/json' }, body: JSON.stringify(body) }))
}
function claims(token: string): { user: number; account: number } {
  const body = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()) as { user?: unknown; account?: unknown }
  check(typeof body.user === 'number' && Number.isSafeInteger(body.user) && body.user > 0 && typeof body.account === 'number' && Number.isSafeInteger(body.account) && body.account > 0, `${active}: invalid backend identity`)
  return { user: body.user, account: body.account }
}
async function signedToken(api: string, wallet: HDNodeWallet, endpoint: string): Promise<string> {
  const challenge = await jsonResponse(await http(`${api}/v1/auth/signMessage?address=${encodeURIComponent(wallet.address)}`, 200))
  check(typeof challenge.message === 'string', `${active}: missing signing challenge`)
  const response = await jsonResponse(await http(`${api}${endpoint}`, 201, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address: wallet.address, signature: await wallet.signMessage(challenge.message) }) }))
  check(typeof response.accessToken === 'string', `${active}: missing backend token`)
  return secret(response.accessToken)
}
function sql(backend: Record<string, string>, account: number): void {
  const host = backend.SQL_HOST || 'localhost'
  check(['localhost', '127.0.0.1', '::1'].includes(host), 'Backend database must be local')
  const command = `UPDATE user_data SET "verifiedName" = 'E2E Admin' WHERE id = ${account} AND ("verifiedName" IS NULL OR "verifiedName" = '');`
  const result = spawnSync('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-h', host, '-p', backend.SQL_PORT || '5432', '-U', backend.SQL_USERNAME || 'sa', '-d', backend.SQL_DB || 'dfx', '-c', command], { env: { ...process.env, PGPASSWORD: backend.SQL_PASSWORD ?? '', PGSSLMODE: backend.SQL_SSL === 'true' ? 'require' : 'disable' }, stdio: 'ignore' })
  check(result.status === 0, 'Admin verified-name update failed')
}
async function waitUntil(deadline: number, interval: number, predicate: () => Promise<boolean>, detail: string): Promise<void> {
  while (Date.now() <= deadline) {
    if (await predicate()) return
    await new Promise((resolvePromise) => setTimeout(resolvePromise, interval))
  }
  fail(detail)
}
function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)) }
  return (crc ^ 0xffffffff) >>> 0
}
function png(): Buffer {
  const chunk = (name: string, data: Buffer) => {
    const type = Buffer.from(name)
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([type, data])))
    return Buffer.concat([length, type, data, crc])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(64, 0); ihdr.writeUInt32BE(64, 4); ihdr[8] = 8; ihdr[9] = 2
  const pixels = Buffer.alloc((64 * 3 + 1) * 64, 180)
  for (let row = 0; row < 64; row++) pixels[row * (64 * 3 + 1)] = 0
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))])
}
function credentials(): { accessToken: string | null; refreshToken: string } | null {
  if (!dbPath || !existsSync(dbPath)) return null
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try { return db.prepare('SELECT accessToken, refreshToken FROM x_credentials WHERE id = 1').get() as { accessToken: string | null; refreshToken: string } | undefined ?? null } finally { db.close() }
}
async function posts(): Promise<Post[]> {
  const current = credentials()
  if (current) { secret(current.refreshToken); if (current.accessToken) secret(current.accessToken) }
  const data = await jsonResponse(await http(`${base}/api/posts`, 200, { headers: headers(authorCookie) }))
  check(Array.isArray(data.posts), `${active}: invalid post list`)
  return data.posts as Post[]
}
async function waitStatus(bundleId: string, expected: string, deadline: number): Promise<Post> {
  let found: Post | undefined
  await waitUntil(deadline, 5_000, async () => {
    found = (await posts()).find((post) => post.bundleId === bundleId)
    if (found?.channel?.status === 'sent' && expected === 'failed') fail('Duplicate post was sent instead of rejected by X')
    if (found?.channel && found.channel.status !== expected && (found.channel.status === 'failed' || found.channel.status === 'uncertain')) {
      const db = new Database(dbPath, { readonly: true, fileMustExist: true })
      try { fail(unexpectedPostStatus(db, found.channel.postId, found.channel.status, secrets)) } finally { db.close() }
    }
    return found?.channel?.status === expected
  }, `Post did not become ${expected} before deadline`)
  return found!
}
async function inspectPublic(url: string, image = false): Promise<void> {
  check(/^https:\/\/x\.com\/[A-Za-z0-9_]+\/status\/\d+$/.test(url), 'Invalid public post URL')
  const id = url.split('/').at(-1)!
  tweets.add(id)
  if (!publicUrls.includes(url)) publicUrls.push(url)
  const embed = await jsonResponse(await http(`https://publish.x.com/oembed?url=${encodeURIComponent(url)}`, 200))
  check(typeof embed.html === 'string' && embed.html.includes(runId), 'Public oEmbed did not contain the run ID')
  if (image) {
    const access = credentials()?.accessToken
    check(access, 'Missing current X access token')
    lastAccess = secret(access)
    const result = await jsonResponse(await http(`https://api.x.com/2/tweets/${id}?expansions=attachments.media_keys&media.fields=type`, 200, { headers: { authorization: `Bearer ${access}` } }))
    check(result.includes?.media?.[0]?.type === 'photo', 'Public post does not include a photo')
  }
}
async function deleteTweet(id: string): Promise<void> {
  const access = credentials()?.accessToken ?? lastAccess
  check(access, 'Missing X access token for cleanup')
  lastAccess = secret(access)
  const response = await jsonResponse(await http(`https://api.x.com/2/tweets/${id}`, 200, { method: 'DELETE', headers: { authorization: `Bearer ${access}` } }))
  check(response.data?.deleted === true, 'X did not confirm deletion')
  tweets.delete(id)
  deletedTweets.add(id)
}

async function timelinePosts(): Promise<Array<{ id: string; text: string }>> {
  const access = credentials()?.accessToken ?? lastAccess
  check(access, 'Missing X access token for timeline cleanup')
  lastAccess = secret(access)
  return findTimelinePosts(async (path) => jsonResponse(await http(`https://api.x.com${path}`, 200, { headers: { authorization: `Bearer ${access}` } })), runId)
}

async function main(): Promise<void> {
  const api = (process.env.DFX_API_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '')
  try {
    const endpoint = new URL(api)
    if (endpoint.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)) throw new NotRun('DFX API must be local HTTP')
  } catch (error) {
    if (error instanceof NotRun) throw error
    throw new NotRun('DFX API URL is invalid')
  }
  backendDir = process.env.DFX_BACKEND_DIR ?? ''
  if (!backendDir) throw new NotRun('DFX_BACKEND_DIR is missing')
  let backend: Record<string, string>
  try { backend = parseEnv(readFileSync(join(backendDir, '.env'), 'utf8')) } catch { throw new NotRun('Backend .env is not readable') }
  if (!backend.JWT_SECRET || !backend.ADMIN_SEED) throw new NotRun('Backend JWT_SECRET or ADMIN_SEED is missing')
  secret(backend.JWT_SECRET); secret(backend.ADMIN_SEED)
  if (spawnSync('psql', ['--version'], { stdio: 'ignore' }).status !== 0) throw new NotRun('psql is unavailable')
  try {
    const response = await fetch(`${api}/v1/auth/introspect/admin`, { redirect: 'manual', signal: AbortSignal.timeout(5_000) })
    if (response.status !== 401) throw new NotRun('Backend introspection endpoint did not return 401')
  } catch (error) { if (error instanceof NotRun) throw error; throw new NotRun('Backend is unreachable') }
  let playwright: any
  try {
    const require = createRequire(join(process.cwd(), '_handbook-deps', 'package.json'))
    playwright = require('playwright')
    if (!existsSync(playwright.chromium.executablePath())) throw new Error('Chromium missing')
  } catch { throw new NotRun('Playwright or Chromium is missing from the handbook dependencies') }
  xPath = process.env.OUTBOX_E2E_X_ENV ?? join(homedir(), '.config/outbox-e2e/x.env')
  let x: Record<string, string> = {}
  if (existsSync(xPath)) {
    try { x = readPrivateEnv(xPath) } catch { throw new NotRun('X environment file is unreadable or does not have mode 600') }
    hasX = ['X_CLIENT_ID', 'X_CLIENT_SECRET', 'X_HANDLE', 'X_REFRESH_TOKEN'].every((key) => Boolean(x[key]))
  }
  if (hasX) {
    secret(x.X_CLIENT_SECRET!); secret(x.X_REFRESH_TOKEN!); xHandle = x.X_HANDLE!.replace(/^@/, '')
    if (!/^[A-Za-z0-9_]{1,15}$/.test(xHandle)) throw new NotRun('X handle is invalid')
  } else x = {}
  record('preconditions', 'pass', hasX ? 'Backend and X configuration present' : 'Backend present; X test account missing')

  await station('start Outbox', async () => {
    temp = mkdtempSync(join(tmpdir(), 'outbox-real-e2e-'))
    dbPath = join(temp, 'outbox.sqlite'); logPath = join(temp, 'outbox.log')
    mkdirSync(join(temp, 'content', 'e2e'), { recursive: true })
    copyFileSync(resolve('scripts/e2e/pack/e2e/rules.json'), join(temp, 'content', 'e2e', 'rules.json'))
    proxy = createXProxy({ upstream: 'https://api.x.com', markedText: textD })
    await new Promise<void>((resolvePromise, reject) => { proxy!.server.once('error', reject); proxy!.server.listen(0, '127.0.0.1', resolvePromise) })
    const proxyPort = (proxy.server.address() as { port: number }).port
    const port = Number(process.env.OUTBOX_E2E_PORT ?? '8080')
    check(Number.isInteger(port) && port > 0 && port <= 65535, 'Invalid Outbox port')
    base = `http://127.0.0.1:${port}`
    const fd = openSync(logPath, 'w', 0o600)
    child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], { cwd: process.cwd(), stdio: ['ignore', fd, fd], env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, PORT: String(port), DB_PATH: dbPath, BRAND: 'e2e', PACK_ROOT: temp, DFX_API_BASE_URL: api, OUTBOX_PUBLIC_URL: base, JWT_SECRET: backend.JWT_SECRET, X_CLIENT_ID: x.X_CLIENT_ID || 'missing', X_CLIENT_SECRET: x.X_CLIENT_SECRET || '', X_REFRESH_TOKEN: x.X_REFRESH_TOKEN || '', X_HANDLE: x.X_HANDLE || 'missing', X_API_BASE: `http://127.0.0.1:${proxyPort}` } })
    closeSync(fd)
    await waitUntil(Date.now() + 30_000, 250, async () => {
      if (child?.exitCode !== null) fail('Outbox process exited during startup')
      try { return (await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) })).status === 200 } catch { return false }
    }, 'Outbox did not start')
  })

  let admin!: HDNodeWallet
  let adminToken = ''
  let composer!: HDNodeWallet
  let composerIdentity!: { user: number; account: number }
  let adminCookie = ''
  await station('prepare approver', async () => {
    admin = HDNodeWallet.fromPhrase(backend.ADMIN_SEED!, undefined, "m/44'/60'/0'/0/0")
    adminToken = await signedToken(api, admin, '/v1/auth/signIn')
    sql(backend, claims(adminToken).account)
    await waitUntil(Date.now() + 150_000, 5_000, async () => {
      const response = await fetch(`${api}/v1/auth/introspect/admin`, { headers: { authorization: `Bearer ${adminToken}` }, signal: AbortSignal.timeout(5_000) })
      return response.status === 200
    }, 'Admin clearance did not become active')
  })
  await station('prepare composer', async () => {
    composer = Wallet.createRandom()
    const initial = await signedToken(api, composer, '/v1/auth')
    composerIdentity = claims(initial)
    const mail = `outbox-e2e-${runId}@example.invalid`
    await http(`${api}/v1/userData/${composerIdentity.account}`, 200, { method: 'PUT', headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ mail, verifiedName: 'E2E Composer' }) })
    await http(`${api}/v1/user/${composerIdentity.user}`, 200, { method: 'PUT', headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ role: 'Outbox' }) })
    await waitUntil(Date.now() + 150_000, 5_000, async () => {
      const adminCheck = await fetch(`${api}/v1/auth/introspect/admin`, { headers: { authorization: `Bearer ${adminToken}` }, signal: AbortSignal.timeout(5_000) })
      const fresh = await signedToken(api, composer, '/v1/auth/signIn')
      const authorCheck = await fetch(`${api}/v1/auth/introspect/outbox`, { headers: { authorization: `Bearer ${fresh}` }, signal: AbortSignal.timeout(5_000) })
      const body = await authorCheck.json() as { message?: unknown }
      return adminCheck.status === 200 && authorCheck.status === 403 && body.message === 'Mail login required'
    }, 'Backend clearance did not become active')
  })
  await station('approver sign-in', async () => {
    const challenge = await jsonResponse(await http(`${base}/auth/wallet/message?address=${encodeURIComponent(admin.address)}`, 200))
    check(typeof challenge.message === 'string', 'Missing Outbox wallet challenge')
    const response = await http(`${base}/auth/wallet`, 200, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ address: admin.address, signature: await admin.signMessage(challenge.message) }) })
    check((await jsonResponse(response)).ok === true, 'Wallet sign-in failed')
    adminCookie = cookie(response, 'outbox')
    check((await jsonResponse(await http(`${base}/api/me`, 200, { headers: headers(adminCookie) }))).role === 'ADMIN', 'Approver role was not ADMIN')
  })
  await station('composer sign-in', async () => {
    const mail = `outbox-e2e-${runId}@example.invalid`
    const apiLog = join(backendDir, 'api.log')
    const before = readFileSync(apiLog, 'utf8').length
    await http(`${base}/auth/mail`, 200, { method: 'POST', headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ mail }).toString() })
    let otp: string | null = null
    await waitUntil(Date.now() + 10_000, 250, async () => { otp = findMailOtp(readFileSync(apiLog, 'utf8'), before, mail); return otp !== null }, 'Mail login link was not logged')
    const redirect = await jsonResponse(await http(`${api}/v1/auth/mail/redirect?code=${encodeURIComponent(otp!)}`, 200))
    check(typeof redirect.redirectUrl === 'string', 'Mail redirect URL missing')
    const redirectUrl = new URL(redirect.redirectUrl)
    check(redirectUrl.origin === base && redirectUrl.pathname === '/auth/callback', 'Unexpected mail callback URL')
    secret(redirectUrl.searchParams.get('session') ?? '')
    const callback = await http(redirectUrl.toString(), 302)
    check(callback.headers.get('location') === '/auth/tfa', 'Callback did not redirect to TOTP')
    const pending = cookie(callback, 'outbox_pending')
    const page = await (await http(`${base}/auth/tfa`, 200, { headers: { cookie: pending } })).text()
    const setupSecret = /Secret:\s*<code>([A-Z2-7=]+)<\/code>/.exec(page)?.[1]
    check(setupSecret, 'TOTP setup secret missing')
    secret(setupSecret)
    const verification = await http(`${base}/auth/tfa`, 302, { method: 'POST', headers: { origin: base, cookie: pending, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code: totp(setupSecret, Date.now()) }).toString() })
    check(verification.headers.get('location') === '/', 'TOTP did not complete')
    authorCookie = cookie(verification, 'outbox')
    const me = await jsonResponse(await http(`${base}/api/me`, 200, { headers: headers(authorCookie) }))
    check(me.role === 'OUTBOX' && me.user === composerIdentity.user && me.account === composerIdentity.account, 'Composer identity does not match backend')
    const reused = await http(`${base}/auth/tfa`, 302, { headers: { cookie: pending } })
    check(reused.headers.get('location') === '/login', 'Pending session was reusable')
  })

  let aSlot!: ReturnType<typeof scheduledSlot>
  const ids: string[] = []
  await station('browser forms', async () => {
    const browser = await playwright.chromium.launch({ headless: true })
    try {
      const context = await browser.newContext()
      const page = await context.newPage()
      const login = await page.goto(`${base}/login`)
      check(login?.status() === 200, 'Browser login page unavailable')
      await page.locator('#mail').fill(`outbox-e2e-${runId}@example.invalid`)
      const [mailResponse] = await Promise.all([
        page.waitForNavigation(),
        page.locator('form[action="/auth/mail"] button').click()
      ])
      check(mailResponse?.status() === 200 && (await page.locator('body').innerText()).includes('Open the link in the email to continue'), 'Browser email form failed')

      aSlot = scheduledSlot(Date.now())
      const created = await postJson('/api/submit', authorCookie, { text: `Outbox E2E ${runId} rejected`, scheduledAt: aSlot.local })
      check(typeof created.bundleId === 'string', 'Browser review submission did not return a bundle ID')
      ids[4] = created.bundleId
      await context.addCookies([{ name: 'outbox', value: adminCookie.slice('outbox='.length), url: base, httpOnly: true, secure: true, sameSite: 'Strict' }])
      const review = await page.goto(`${base}/review/${encodeURIComponent(created.bundleId)}`)
      check(review?.status() === 200, 'Browser review page unavailable')
      await page.locator('#decision-comment').fill('E2E rejection')
      const [decisionResponse] = await Promise.all([
        page.waitForNavigation(),
        page.locator('button[name="decision"][value="reject"]').click()
      ])
      check(decisionResponse?.status() === 200 && (await page.locator('body').innerText()).includes('Rejected.'), 'Browser rejection form failed')
      const rejected = (await posts()).find((post) => post.bundleId === created.bundleId)
      check(rejected?.state === 'rejected' && rejected.decisionComment === 'E2E rejection', 'Browser rejection was not recorded')
    } finally { await browser.close() }
  })
  const cSlot = scheduledSlot(aSlot.epoch - 60_000, 1)
  const dSlot = scheduledSlot(cSlot.epoch - 60_000, 1)
  await station('compose and decide', async () => {
    const blocked = await postJson('/api/review', authorCookie, { text: 'e2e-forbidden-phrase' })
    check(Array.isArray(blocked.blocking) && blocked.blocking.length > 0, 'Forbidden phrase was not blocked')
    await postJson('/api/submit', authorCookie, { text: 'e2e-forbidden-phrase', scheduledAt: aSlot.local }, 409)
    for (const [index, text] of [textA, textB, textA, textD].entries()) {
      const slot = index === 2 ? cSlot : index === 3 ? dSlot : aSlot
      let result: Record<string, any>
      if (index === 1) {
        const form = new FormData()
        form.set('text', text); form.set('scheduledAt', slot.local); form.set('image', new Blob([new Uint8Array(png())], { type: 'image/png' }), 'image.png')
        result = await jsonResponse(await http(`${base}/api/submit`, 200, { method: 'POST', headers: headers(authorCookie), body: form }))
      } else result = await postJson('/api/submit', authorCookie, { text, scheduledAt: slot.local })
      check(typeof result.bundleId === 'string', 'Submission did not return a bundle ID')
      ids[index] = result.bundleId
    }
    for (const id of ids.slice(0, 4)) await postJson(`/review/${id}/decide`, adminCookie, { decision: 'approve' })
    const rows = await posts()
    for (const id of ids.slice(0, 4)) { const post = rows.find((row) => row.bundleId === id); check(post?.state === 'approved' && post.channel?.status === 'pending', 'Approved post is not pending') }
    const rejected = rows.find((row) => row.bundleId === ids[4])
    check(rejected?.state === 'rejected' && rejected.decisionComment === 'E2E rejection', 'Rejected post or comment missing')
  })
  if (!hasX) { active = 'publish, image, retry and resolve'; throw new NotRun('X test account missing — publish, image, retry and resolve not run') }

  await station('publish text and image', async () => {
    const first = await waitStatus(ids[0]!, 'sent', aSlot.epoch + 120_000)
    const second = await waitStatus(ids[1]!, 'sent', aSlot.epoch + 120_000)
    check(first.channel?.url && second.channel?.url, 'Published URL missing')
    await inspectPublic(first.channel.url)
    await inspectPublic(second.channel.url, true)
  })
  await station('retry duplicate', async () => {
    const duplicate = await waitStatus(ids[2]!, 'failed', cSlot.epoch + 120_000)
    const first = (await posts()).find((post) => post.bundleId === ids[0])
    check(first?.channel?.url && duplicate.channel, 'Retry prerequisites missing')
    await deleteTweet(first.channel.url.split('/').at(-1)!)
    await postJson(`/api/posts/${duplicate.channel.postId}/retry`, adminCookie, {})
    const retried = await waitStatus(ids[2]!, 'sent', Date.now() + 120_000)
    check(retried.channel?.url, 'Retried post URL missing')
    await inspectPublic(retried.channel.url)
  })
  await station('resolve uncertain', async () => {
    const uncertain = await waitStatus(ids[3]!, 'uncertain', dSlot.epoch + 120_000)
    const id = proxy?.droppedTweetIds[0]
    check(id && uncertain.channel, 'Proxy did not capture a real X post ID')
    tweets.add(id)
    const url = `https://x.com/${xHandle}/status/${id}`
    await postJson(`/api/posts/${uncertain.channel.postId}/resolve-uncertain`, adminCookie, { resolution: 'sent', url })
    const resolved = await waitStatus(ids[3]!, 'sent', Date.now() + 10_000)
    check(resolved.channel?.url === url, 'Resolved URL differs from X response')
    await inspectPublic(url)
  })
}

try { await main() } catch (error) {
  exitCode = error instanceof NotRun ? 3 : 1
  const detail = error instanceof NotRun ? `not run: ${error.message}` : error instanceof E2eFailure ? error.message : `${active} failed`
  record(active, exitCode === 3 ? 'not-run' : 'fail', detail)
} finally {
  if (hasX && authorCookie) {
    let cleanupFailed = false
    try {
      for (const post of await posts()) if (post.channel?.url && post.channel.url.includes('/status/')) {
        if (!publicUrls.includes(post.channel.url)) publicUrls.push(post.channel.url)
        const id = post.channel.url.split('/').at(-1)!
        if (!deletedTweets.has(id)) tweets.add(id)
      }
    } catch { cleanupFailed = true }
    for (const id of proxy?.droppedTweetIds ?? []) {
      if (!deletedTweets.has(id)) tweets.add(id)
      const url = `https://x.com/${xHandle}/status/${id}`
      if (!publicUrls.includes(url)) publicUrls.push(url)
    }
    active = 'cleanup tweets'
    try {
      await cleanupTimelinePosts(async () => {
        const posts = await timelinePosts()
        for (const post of posts) {
          const url = `https://x.com/${xHandle}/status/${post.id}`
          if (!publicUrls.includes(url)) publicUrls.push(url)
        }
        return posts
      }, deleteTweet, tweets)
    } catch { cleanupFailed = true }
    if (cleanupFailed) { exitCode = 1; record(active, 'fail', 'Tweet cleanup failed') }
    else record(active, 'pass', 'Run tweets deleted')
  }
  if (child && child.exitCode === null) {
    child.kill('SIGTERM')
    await new Promise<void>((resolvePromise) => { const timer = setTimeout(() => { child?.kill('SIGKILL'); resolvePromise() }, 110_000); child!.once('exit', () => { clearTimeout(timer); resolvePromise() }) })
  }
  if (proxy?.server.listening) await new Promise<void>((resolvePromise) => proxy!.server.close(() => resolvePromise()))
  if (hasX && dbPath && existsSync(dbPath)) {
    try {
      const current = credentials()
      if (current) { secret(current.refreshToken); if (current.accessToken) secret(current.accessToken); saveRefreshToken(xPath, current.refreshToken); record('refresh token', 'pass', 'Current token retained') }
      else record('refresh token', 'not-run', 'No token was stored by Outbox')
    } catch { exitCode = 1; record('refresh token', 'fail', 'Could not preserve current refresh token') }
  }
  if (logPath && existsSync(logPath)) {
    const log = readFileSync(logPath, 'utf8')
    if ([...secrets].some((value) => value && log.includes(value))) { exitCode = 1; record('secret log check', 'fail', 'Sensitive value found in Outbox log') }
    else record('secret log check', 'pass', 'No known sensitive values in Outbox log')
  }
  const expectedStations = ['preconditions', 'start Outbox', 'prepare approver', 'prepare composer', 'approver sign-in', 'composer sign-in', 'browser forms', 'compose and decide', 'publish text and image', 'retry duplicate', 'resolve uncertain', 'cleanup tweets', 'refresh token', 'secret log check']
  for (const name of expectedStations) {
    if (!stations.some((entry) => entry.name === name)) record(name, 'not-run', 'Not reached')
  }
  for (const entry of stations) entry.detail = redactKnownSecrets(entry.detail, secrets)
  const report = { outboxCommit: git(['rev-parse', 'HEAD'], process.cwd()), outboxDirty: git(['status', '--porcelain'], process.cwd()) !== '', backendCommit: backendDir ? git(['rev-parse', 'HEAD'], backendDir) : 'unavailable', start, end: new Date().toISOString(), stations, publicPostUrls: publicUrls, exitCode }
  writeFileSync('e2e-run.json', `${JSON.stringify(report, null, 2)}\n`)
  process.stdout.write(`| Command | Commit | Exit |\n| --- | --- | --- |\n| npm run test:e2e | ${report.outboxCommit} | ${exitCode} |\n\n| Station | Result | Detail |\n| --- | --- | --- |\n${stations.map((item) => `| ${item.name} | ${item.result} | ${item.detail} |`).join('\n')}\n`)
  if (temp) rmSync(temp, { recursive: true, force: true })
  process.exitCode = exitCode
}
