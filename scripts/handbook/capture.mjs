import { createHash, createHmac } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const outputRoot = join(repoRoot, 'docs/handbook/screenshots')
const viewport = { width: 760, height: 900 }
const captureViewport = { width: 760, height: 'visible body content + 24px' }
const deviceScaleFactor = 2
const secret = 'handbook-capture-throwaway-secret'
let releaseFlight
let flightStarted
const flightSignal = new Promise((resolvePromise) => { flightStarted = resolvePromise })
const flightRelease = new Promise((resolvePromise) => { releaseFlight = resolvePromise })
let app
let appProcesses = []
let browser
let stub
let tempRoots = []
let appPort
let stubPort
let written = []
let xTweetSequence = 1_000_000_000
const xResponses = new Map([
  ['The shipment update is ready for review.', 'flight'],
  ['The weekly schedule is ready to share.', 'failed'],
  ['The service update is waiting for confirmation.', 'uncertain'],
  ['The second status update needs a decision.', 'uncertain']
])

function fail(message) { throw new Error(message) }

function jwt(role, account = 'handbook-composer') {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const header = encode({ alg: 'HS256', typ: 'JWT' })
  const payload = encode({ address: 'handbook@example.invalid', user: 'handbook-user', account, role })
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')
  return `${header}.${payload}.${signature}`
}

function listen(server) {
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolvePromise(server.address().port)
    })
  })
}

async function readRequestBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

function writeJson(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(value))
}

async function startStub() {
  stub = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/v1/auth/introspect/outbox' || url.pathname === '/v1/auth/introspect/admin') {
      const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? '')?.[1]
      const claims = bearer?.split('.')[1]
      if (!claims) return writeJson(response, 401, { message: 'Sign in required.' })
      const identity = JSON.parse(Buffer.from(claims, 'base64url').toString('utf8'))
      if (url.pathname.endsWith('/admin') && identity.role !== 'ADMIN') return writeJson(response, 403, { message: 'Not allowed.' })
      return writeJson(response, 200, { user: identity.user, account: identity.account, role: identity.role })
    }
    if (url.pathname === '/2/oauth2/token') return writeJson(response, 200, { access_token: 'handbook-access-token', refresh_token: 'handbook-refresh-token', expires_in: 7200 })
    if (url.pathname === '/2/users/me') return writeJson(response, 200, { data: { username: 'handbook_demo' } })
    if (url.pathname === '/2/tweets' && request.method === 'POST') {
      const body = JSON.parse(await readRequestBody(request))
      const responseType = xResponses.get(body.text)
      if (responseType === 'flight') {
        flightStarted()
        await flightRelease
      }
      if (responseType === 'failed') return writeJson(response, 400, { title: 'Invalid request', detail: 'Fixture failure.' })
      if (responseType === 'uncertain') return writeJson(response, 500, { title: 'Temporary error' })
      const id = `${xTweetSequence++}`
      return writeJson(response, 201, { data: { id } })
    }
    response.writeHead(404)
    response.end('Not found')
  })
  stubPort = await listen(stub)
}

async function startApp({ missingPack = false } = {}) {
  const tempRoot = mkdtempSync(join(tmpdir(), 'outbox-handbook-'))
  tempRoots.push(tempRoot)
  const packRoot = join(tempRoot, 'pack')
  if (!missingPack) {
    mkdirSync(join(packRoot, 'content', 'handbook'), { recursive: true })
    writeFileSync(join(packRoot, 'content', 'handbook', 'rules.json'), JSON.stringify({
      topic: 'Handbook example',
      forbiddenClaims: ['guaranteed returns'],
      provisionalParameters: [],
      micarUnsafe: [],
      maxEmoji: 0
    }))
  } else {
    mkdirSync(packRoot, { recursive: true })
  }
  const portServer = createServer()
  appPort = await listen(portServer)
  await new Promise((resolvePromise) => portServer.close(resolvePromise))
  app = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(appPort),
      DB_PATH: join(tempRoot, 'outbox.sqlite'),
      PACK_ROOT: packRoot,
      BRAND: 'handbook',
      DFX_API_BASE_URL: `http://127.0.0.1:${stubPort}`,
      JWT_SECRET: secret,
      X_CLIENT_ID: 'handbook-client',
      X_CLIENT_SECRET: 'handbook-secret',
      X_REFRESH_TOKEN: 'handbook-refresh-token',
      X_HANDLE: '@handbook_demo',
      X_API_BASE: `http://127.0.0.1:${stubPort}`
    }
  })
  appProcesses.push(app)
  let logs = ''
  app.stdout.on('data', (chunk) => { logs = `${logs}${chunk}`.slice(-8000) })
  app.stderr.on('data', (chunk) => { logs = `${logs}${chunk}`.slice(-8000) })
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (app.exitCode !== null) fail(`Outbox process exited before healthz: ${logs}`)
    try {
      const response = await fetch(`http://127.0.0.1:${appPort}/healthz`)
      if (response.status === 200 && (await response.json()).ok === !missingPack) return
    } catch {}
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
  }
  fail(`Timed out waiting for /healthz: ${logs}`)
}

async function playwright() {
  try {
    const require = createRequire(join(repoRoot, '_handbook-deps', 'package.json'))
    return require('playwright')
  } catch {
    fail('Playwright is missing. Install it with: npm install --prefix ./_handbook-deps --no-save playwright@1.61.1')
  }
}

async function context(role, account = 'handbook-composer') {
  const browserContext = await browser.newContext({ viewport, deviceScaleFactor, locale: 'en-GB', timezoneId: 'Europe/Zurich', extraHTTPHeaders: { authorization: `Bearer ${jwt(role, account)}` } })
  return { context: browserContext, page: await browserContext.newPage() }
}

async function pageHeight(page) {
  await page.setViewportSize({ width: viewport.width, height: 200 })
  const height = await page.evaluate(() => {
    const bottoms = [...document.body.children].map((element) => {
      const style = getComputedStyle(element)
      const rect = element.getBoundingClientRect()
      return style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0 || rect.width === 0 || rect.height === 0
        ? 0
        : rect.bottom
    })
    return Math.ceil(Math.max(0, ...bottoms)) + 24
  })
  await page.setViewportSize({ width: viewport.width, height: Math.max(120, height) })
}

async function capture(page, group, name, expected, { write = true } = {}) {
  const content = await page.locator('body').innerText()
  for (const text of expected) if (!content.toLowerCase().includes(text.toLowerCase())) fail(`${group}/${name}: expected page text ${JSON.stringify(text)}; got ${JSON.stringify(content)}`)
  await pageHeight(page)
  const image = join(outputRoot, group, `${name}.png`)
  if (write) mkdirSync(dirname(image), { recursive: true })
  const buffer = await page.screenshot({ ...(write ? { path: image } : {}), animations: 'disabled' })
  if (write) {
    written.push(image)
  }
  return buffer
}

async function captureSharedState(composerPage, approverPage, name, expected) {
  const approverImage = await capture(approverPage, '02-review-approver', name, expected)
  const composerImage = await capture(composerPage, '03-review-author', name, expected, { write: false })
  if (approverImage.equals(composerImage)) return
  const path = join(outputRoot, '03-review-author', `${name}.png`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, composerImage)
  written.push(path)
  if (!existsSync(path.replace(/\.png$/i, '.md'))) fail(`Composer view ${name} differs from approver view and has no matching Markdown description`)
}

function zonedDate(minutesFromNow, fixed = false) {
  if (fixed) return `${new Date().getFullYear() + 1}-06-15T10:00`
  const future = Date.now() + minutesFromNow * 60_000
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(future))
  const value = (name) => parts.find((part) => part.type === name).value
  return `${value('year')}-${value('month')}-${value('day')}T${value('hour')}:${value('minute')}`
}

async function submit(composer, text, time = zonedDate(10, true)) {
  await composer.page.goto(`http://127.0.0.1:${appPort}/`)
  await composer.page.locator('#text').fill(text)
  await composer.page.locator('#scheduledAt').fill(time)
  await Promise.all([composer.page.waitForNavigation(), composer.page.locator('button[type=submit]').click()])
  const match = /\/review\/([^/?]+)/.exec(composer.page.url())
  if (!match) return { responsePage: composer.page, bundleId: null }
  return { responsePage: composer.page, bundleId: decodeURIComponent(match[1]) }
}

async function reviewPage(browserContext, bundleId) {
  const page = await browserContext.newPage()
  await page.goto(`http://127.0.0.1:${appPort}/review/${bundleId}`)
  return page
}

async function clickDecision(page, decision) {
  const request = page.waitForNavigation()
  await page.locator(`button[name=decision][value=${decision}]`).click()
  await request
}

async function resultFromRealResponse(page, method, path, { role = 'ADMIN', account = 'handbook-composer', body = '', origin, cookie, unauthenticated = false, expectedStatus } = {}) {
  const headers = unauthenticated ? {} : { authorization: `Bearer ${jwt(role, account)}` }
  if (body) headers['content-type'] = 'application/x-www-form-urlencoded'
  if (origin) headers.origin = origin
  if (cookie) { delete headers.authorization; headers.cookie = cookie }
  const response = await fetch(`http://127.0.0.1:${appPort}${path}`, { method, headers, ...(body ? { body } : {}) })
  const responseBody = await response.text()
  if (expectedStatus !== undefined && response.status !== expectedStatus) fail(`${method} ${path}: expected ${expectedStatus}, got ${response.status}: ${responseBody}`)
  const target = `http://127.0.0.1:${appPort}${path}`
  await page.route(target, (route) => route.fulfill({ status: response.status, body: responseBody, headers: { 'content-type': response.headers.get('content-type') ?? 'text/html; charset=utf-8' } }), { times: 1 })
  await page.goto(target)
  return { status: response.status, body: responseBody }
}

async function waitFor(text, timeoutMs = 180_000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const rows = await fetch(`http://127.0.0.1:${appPort}/api/posts`, { headers: { authorization: `Bearer ${jwt('ADMIN')}` } }).then((response) => response.json())
    if (JSON.stringify(rows).includes(text)) return rows
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000))
  }
  fail(`Timed out waiting for publisher state containing ${text}`)
}

async function makeDueAndApprove(composer, approver, text, stateName) {
  const created = await submit(composer, text, zonedDate(2))
  if (!created.bundleId) fail(`${stateName}: could not create entry`)
  const review = await reviewPage(approver.context, created.bundleId)
  await clickDecision(review, 'approve')
  return { bundleId: created.bundleId, page: review }
}

async function captureStaticErrors(composer, approver) {
  const page = await approver.context.newPage()
  await page.goto(`http://127.0.0.1:${appPort}/`)
  await page.evaluate(() => { document.cookie = 'outbox=invalid; path=/' })
  await resultFromRealResponse(page, 'GET', '/', { unauthenticated: true, expectedStatus: 401 })
  await capture(page, '04-results-and-errors', '06-sign-in-required', ['Sign in required'])

  await resultFromRealResponse(page, 'POST', '/api/submit', { role: 'OUTBOX', body: 'text=Fixture&scheduledAt=2030-01-01T10%3A00' , cookie: `outbox=${encodeURIComponent(jwt('OUTBOX'))}`, origin: 'https://example.invalid', expectedStatus: 403 })
  await capture(page, '04-results-and-errors', '07-forbidden-origin', ['Forbidden', 'Origin does not match this host.'])

  await resultFromRealResponse(page, 'GET', '/review/unknown-handbook-entry', { role: 'OUTBOX', expectedStatus: 404 })
  await capture(page, '04-results-and-errors', '08-not-found', ['Request failed', 'Not found.'])

  const privateEntry = await submit(composer, 'A neutral private example for visibility.', zonedDate(10, true))
  await resultFromRealResponse(page, 'GET', `/review/${privateEntry.bundleId}`, { role: 'OUTBOX', account: 'other-handbook-composer', expectedStatus: 403 })
  await capture(page, '04-results-and-errors', '09-not-visible', ['Request failed', 'Not visible.'])

  await resultFromRealResponse(page, 'POST', `/review/${privateEntry.bundleId}/decide`, { role: 'OUTBOX', body: 'decision=approve', expectedStatus: 403 })
  await capture(page, '04-results-and-errors', '10-not-allowed', ['Request failed', 'Not allowed.'])

  await resultFromRealResponse(page, 'POST', `/review/${privateEntry.bundleId}/decide`, { role: 'ADMIN', body: 'decision=approve', expectedStatus: 200 })
  await resultFromRealResponse(page, 'POST', `/review/${privateEntry.bundleId}/decide`, { role: 'ADMIN', body: 'decision=reject', expectedStatus: 409 })
  await capture(page, '04-results-and-errors', '11-decision-conflict', ['Request failed', 'Decide conflict.'])

  await resultFromRealResponse(page, 'POST', `/review/${privateEntry.bundleId}/decide`, { role: 'ADMIN', body: 'decision=invalid', expectedStatus: 400 })
  await capture(page, '04-results-and-errors', '12-invalid-decision', ['Request failed', 'decision must be approve or reject.'])
}

async function main() {
  const { chromium } = await playwright()
  for (const group of readdirSync(outputRoot, { withFileTypes: true })) {
    if (!group.isDirectory()) continue
    for (const name of readdirSync(join(outputRoot, group.name))) {
      if (name.toLowerCase().endsWith('.png')) rmSync(join(outputRoot, group.name, name), { force: true })
    }
  }
  await startStub()
  await startApp()
  browser = await chromium.launch({ headless: true, args: ['--lang=en-GB'] })
  const composer = await context('OUTBOX')
  const approver = await context('ADMIN')

  await composer.page.goto(`http://127.0.0.1:${appPort}/`)
  const language = await composer.page.evaluate(() => navigator.language)
  if (language !== 'en-GB') fail(`Expected browser language en-GB before the blank form capture; got ${language}`)
  await capture(composer.page, '01-composer', '01-blank', ['Submit for approval', 'Preview'])

  await composer.page.locator('#text').fill('Guaranteed returns for everyone who joins this week.')
  await composer.page.locator('#scheduledAt').fill(zonedDate(10, true))
  await Promise.all([composer.page.waitForNavigation(), composer.page.locator('button[type=submit]').click()])
  await capture(composer.page, '01-composer', '02-blocked', ['Blocking review finding.', 'Forbidden claim: guaranteed returns'])

  await composer.page.locator('#text').fill('A neutral post with a future review time.')
  await composer.page.locator('#scheduledAt').fill(zonedDate(-1))
  await Promise.all([composer.page.waitForNavigation(), composer.page.locator('button[type=submit]').click()])
  await capture(composer.page, '01-composer', '03-past-time', ['The scheduled time is already in the past.'])

  const clear = await submit(composer, 'A short update is scheduled after tomorrow’s review.')
  const clearApprover = await reviewPage(approver.context, clear.bundleId)
  await capture(clearApprover, '02-review-approver', '01-submitted-clear', ['submitted', 'Approve', 'Reject', 'No blocking findings and no hints.'])
  await capture(await reviewPage(composer.context, clear.bundleId), '03-review-author', '01-submitted-clear', ['submitted', 'No blocking findings and no hints.'])
  await clickDecision(clearApprover, 'approve')
  await capture(clearApprover, '04-results-and-errors', '01-approved-queued', ['Decided', 'Approved and queued.'])
  const approvedBundle = clear.bundleId
  const approvedReview = await reviewPage(approver.context, approvedBundle)
  await captureSharedState(await reviewPage(composer.context, approvedBundle), approvedReview, '04-pending', ['approved', 'pending'])

  const hintText = 'Our team will review the updated schedule, confirm the revised delivery window, check that every location has the correct contact details, and share the final notice with staff once the maintenance work is complete before offices reopen.'
  const hinted = await submit(composer, hintText)
  const hintedAdmin = await reviewPage(approver.context, hinted.bundleId)
  await capture(hintedAdmin, '02-review-approver', '02-submitted-hints', ['A sentence is longer than 35 words.', 'Approve', 'Reject'])
  await capture(await reviewPage(composer.context, hinted.bundleId), '03-review-author', '02-submitted-hints', ['A sentence is longer than 35 words.'])
  await clickDecision(hintedAdmin, 'reject')
  await capture(hintedAdmin, '04-results-and-errors', '02-rejected-result', ['Decided', 'Rejected.'])
  await captureSharedState(await reviewPage(composer.context, hinted.bundleId), await reviewPage(approver.context, hinted.bundleId), '09-rejected', ['rejected'])

  const pastLock = await submit(composer, 'A post that will be reviewed after its time.', zonedDate(1))
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 65_000))
  const lockedReview = await reviewPage(approver.context, pastLock.bundleId)
  await capture(lockedReview, '02-review-approver', '03-submitted-past', ['scheduled time has already passed', 'Reject'])
  await capture(await reviewPage(composer.context, pastLock.bundleId), '03-review-author', '03-submitted-past', ['scheduled time has already passed'])
  await clickDecision(lockedReview, 'reject')

  const retractable = await submit(composer, 'The monthly team update is ready for review.')
  await resultFromRealResponse(composer.page, 'POST', `/api/bundles/${retractable.bundleId}/retract`, { role: 'OUTBOX' })
  await captureSharedState(await reviewPage(composer.context, retractable.bundleId), await reviewPage(approver.context, retractable.bundleId), '10-retracted', ['retracted'])

  const flight = await makeDueAndApprove(composer, approver, 'The shipment update is ready for review.', 'in-flight')
  await flightSignal
  const flightAdmin = await reviewPage(approver.context, flight.bundleId)
  await captureSharedState(await reviewPage(composer.context, flight.bundleId), flightAdmin, '05-in-flight', ['in-flight'])
  releaseFlight()
  await waitFor('sent')
  await captureSharedState(await reviewPage(composer.context, flight.bundleId), await reviewPage(approver.context, flight.bundleId), '06-sent', ['sent', 'View published post'])

  const failed = await makeDueAndApprove(composer, approver, 'The weekly schedule is ready to share.', 'failed')
  await waitFor('failed')
  const failedAdmin = await reviewPage(approver.context, failed.bundleId)
  await capture(failedAdmin, '02-review-approver', '07-failed', ['failed', 'Retry'])
  await capture(await reviewPage(composer.context, failed.bundleId), '03-review-author', '07-failed', ['failed'])
  await Promise.all([failedAdmin.waitForNavigation(), failedAdmin.locator('button').filter({ hasText: 'Retry' }).click()])
  await capture(failedAdmin, '04-results-and-errors', '03-retry-result', ['Post updated', 'pending'])

  const uncertain = await makeDueAndApprove(composer, approver, 'The service update is waiting for confirmation.', 'uncertain')
  await waitFor('uncertain')
  const uncertainAdmin = await reviewPage(approver.context, uncertain.bundleId)
  await capture(uncertainAdmin, '02-review-approver', '08-uncertain', ['uncertain', 'Permalink', 'Mark as sent', 'Mark as failed'])
  await capture(await reviewPage(composer.context, uncertain.bundleId), '03-review-author', '08-uncertain', ['uncertain'])
  await uncertainAdmin.locator('#post-url').fill('https://x.com/handbook_demo/status/123456789')
  await Promise.all([uncertainAdmin.waitForNavigation(), uncertainAdmin.locator('button').filter({ hasText: 'Mark as sent' }).click()])
  await capture(uncertainAdmin, '04-results-and-errors', '04-resolve-sent-result', ['Post updated', 'sent'])
  const uncertainAgain = await makeDueAndApprove(composer, approver, 'The second status update needs a decision.', 'uncertain')
  await waitFor('uncertain')
  const uncertainFailed = await reviewPage(approver.context, uncertainAgain.bundleId)
  await Promise.all([uncertainFailed.waitForNavigation(), uncertainFailed.locator('button').filter({ hasText: 'Mark as failed' }).click()])
  await capture(uncertainFailed, '04-results-and-errors', '05-resolve-failed-result', ['Post updated', 'failed'])

  const originalApp = app
  const originalAppPort = appPort
  await startApp({ missingPack: true })
  const missingPackContext = await context('OUTBOX')
  await missingPackContext.page.goto(`http://127.0.0.1:${appPort}/`)
  await missingPackContext.page.locator('#text').fill('We will share the revised opening hours tomorrow morning.')
  await missingPackContext.page.locator('#scheduledAt').fill(zonedDate(10, true))
  await Promise.all([missingPackContext.page.waitForNavigation(), missingPackContext.page.locator('button[type=submit]').click()])
  await capture(missingPackContext.page, '01-composer', '04-pack-missing', ['Review pack is missing.'])
  await missingPackContext.context.close()
  app = originalApp
  appPort = originalAppPort

  await captureStaticErrors(composer, approver)

  const pngs = []
  const markdown = []
  for (const group of readdirSync(outputRoot, { withFileTypes: true })) {
    if (!group.isDirectory()) continue
    for (const file of readdirSync(join(outputRoot, group.name))) {
      const path = `${group.name}/${file}`
      if (file.toLowerCase().endsWith('.png')) pngs.push(path)
      if (file.toLowerCase().endsWith('.md') && file.toLowerCase() !== '_group.md') markdown.push(path)
    }
  }
  const key = (path) => path.replace(/\.(png|md)$/i, '').toLowerCase()
  const pngKeys = new Set(pngs.map(key))
  const markdownKeys = new Set(markdown.map(key))
  const missing = pngs.filter((file) => !markdownKeys.has(key(file)))
  const unpaired = markdown.filter((file) => !pngKeys.has(key(file)))
  if (missing.length || unpaired.length) fail(`Capture pairs are incomplete. Missing text for: ${missing.join(', ')}. Missing images for: ${unpaired.join(', ')}`)
  written = pngs.map((path) => join(outputRoot, path))
  const htmlSha256 = createHash('sha256').update(readFileSync(join(repoRoot, 'src/html.ts'))).digest('hex')
  writeFileSync(join(outputRoot, 'capture.json'), `${JSON.stringify({ htmlSha256, viewport: captureViewport, deviceScaleFactor, count: written.length }, null, 2)}\n`)
  process.stdout.write(`Captured ${written.length} screenshots\n`)
}

try {
  await main()
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
} finally {
  if (releaseFlight) releaseFlight()
  if (browser) await browser.close().catch(() => {})
  for (const process of appProcesses) {
    if (process.exitCode === null) {
      process.kill('SIGTERM')
      await new Promise((resolvePromise) => process.once('exit', resolvePromise))
    }
  }
  if (stub) await new Promise((resolvePromise) => stub.close(resolvePromise))
  for (const tempRoot of tempRoots) rmSync(tempRoot, { recursive: true, force: true })
}
