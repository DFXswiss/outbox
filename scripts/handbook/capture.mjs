// JavaScript lets capture load Playwright from its isolated dependency directory, outside package.json resolution.
import { createHash, createHmac } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { installCapture } from './capture-install.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const finalOutputRoot = join(repoRoot, 'docs/handbook/screenshots')
let outputRoot = finalOutputRoot
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
let preservedStageRoot = null
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
    if (url.pathname === '/2/media/upload' && request.method === 'POST') {
      await readRequestBody(request)
      return writeJson(response, 200, { data: { id: 'handbook-media-1', media_key: '3_1' } })
    }
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

const allDecisionButtons = ['Approve', 'Reject', 'Retry', 'Mark as sent', 'Mark as failed']
const disabledSubmitStates = new Set(['01-composer/06-typing-blocked'])
const stateButtonPolicy = {
  '02-review-approver/01-submitted-clear': ['Approve', 'Reject'],
  '02-review-approver/11-submitted-image': ['Approve', 'Reject'],
  '02-review-approver/02-submitted-hints': ['Approve', 'Reject'],
  '02-review-approver/03-submitted-past': ['Reject'],
  '02-review-approver/07-failed': ['Retry'],
  '02-review-approver/08-uncertain': ['Mark as sent', 'Mark as failed'],
  '01-composer/01-blank': [],
  '01-composer/02-blocked': [],
  '01-composer/03-past-time': [],
  '01-composer/04-pack-missing': [],
  '01-composer/05-typing-clear': [],
  '01-composer/06-typing-blocked': [],
  '01-composer/07-image-selected': [],
  '01-composer/08-bad-image': [],
  '01-composer/09-image-dropped': [],
  '05-posts/01-author-list': [],
  '05-posts/02-approver-list': [],
  '05-posts/03-empty-author': [],
  '05-posts/04-empty-approver': []
}

async function capture(page, group, name, expected, { write = true } = {}) {
  const content = await page.locator('body').innerText()
  for (const text of expected) if (!content.toLowerCase().includes(text.toLowerCase())) fail(`${group}/${name}: expected page text ${JSON.stringify(text)}; got ${JSON.stringify(content)}`)
  const allowed = new Set(stateButtonPolicy[`${group}/${name}`] ?? [])
  for (const label of allDecisionButtons) {
    const count = await page.getByRole('button', { name: label, exact: true }).count()
    const expectedCount = allowed.has(label) ? 1 : 0
    if (count !== expectedCount) fail(`${group}/${name}: expected ${expectedCount} button(s) named ${JSON.stringify(label)}, found ${count}`)
  }
  if (group === '01-composer') {
    const submitButton = page.getByRole('button', { name: 'Submit for approval', exact: true })
    const submitCount = await submitButton.count()
    if (submitCount !== 1) fail(`${group}/${name}: expected exactly one Submit for approval button, found ${submitCount}`)
    const disabled = await submitButton.isDisabled()
    if (disabled !== disabledSubmitStates.has(`${group}/${name}`)) fail(`${group}/${name}: unexpected Submit for approval disabled state`)
  }
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
  if (!existsSync(join(finalOutputRoot, '03-review-author', `${name}.md`))) fail(`Composer view ${name} differs from approver view and has no matching Markdown description`)
}

function zonedDate(minutesFromNow, fixed = false) {
  const future = fixed
    ? Date.UTC(new Date().getFullYear() + 1, 5, 15, 8, 0)
    : Date.now() + minutesFromNow * 60_000
  const rounded = Math.ceil(future / 300_000) * 300_000
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(rounded))
  const value = (name) => parts.find((part) => part.type === name).value
  return { date: `${value('year')}-${value('month')}-${value('day')}`, hour: value('hour'), minute: value('minute') }
}

async function setScheduledTime(page, value) {
  await page.locator('#scheduledDate').fill(value.date)
  await page.locator('#scheduledHour').selectOption(value.hour)
  await page.locator('#scheduledMinute').selectOption(value.minute)
}

function crc32(data) {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const name = Buffer.from(type)
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])))
  return Buffer.concat([length, name, data, checksum])
}

function handbookPng() {
  const width = 600
  const height = 315
  const rows = Buffer.alloc(height * (1 + width * 4))
  for (let y = 0; y < height; y += 1) {
    const offset = y * (1 + width * 4)
    rows[offset] = 0
    for (let x = 0; x < width; x += 1) {
      const ratio = x / (width - 1)
      const pixel = offset + 1 + x * 4
      rows[pixel] = Math.round(0x1e + (255 - 0x1e) * ratio)
      rows[pixel + 1] = Math.round(0x6e + (255 - 0x6e) * ratio)
      rows[pixel + 2] = Math.round(0xf7 + (255 - 0xf7) * ratio)
      rows[pixel + 3] = 255
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

function captureInputs() {
  const walk = (directory) => readdirSync(join(repoRoot, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`
    if (entry.isDirectory()) return walk(path)
    return entry.isFile() && !entry.name.endsWith('.test.ts') ? [path] : []
  })
  return [...walk('src'), ...walk('review'), 'scripts/handbook/capture-install.mjs', 'scripts/handbook/capture.mjs'].sort((left, right) => left.localeCompare(right, 'en'))
}

function pngPaths(root, prefix = '') {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
    const absolutePath = join(root, entry.name)
    if (entry.isDirectory()) return pngPaths(absolutePath, relativePath)
    return entry.isFile() && entry.name.toLowerCase().endsWith('.png') ? [relativePath] : []
  })
}

function installStagedCapture(stageRoot, stagedPngs, metadataPath) {
  const previousPngs = pngPaths(finalOutputRoot)
  const previousFiles = [
    ...previousPngs.map((relativePath) => ({ source: join(finalOutputRoot, relativePath), relativePath })),
    { source: join(finalOutputRoot, 'capture.json'), relativePath: 'capture.json' }
  ]
  const stagedFiles = stagedPngs.map((relativePath) => ({
    source: join(outputRoot, relativePath),
    destination: join(finalOutputRoot, relativePath)
  }))
  installCapture({
    stageRoot,
    previousFiles,
    stagedFiles,
    metadataSource: metadataPath,
    metadataDestination: join(finalOutputRoot, 'capture.json')
  })
}

async function submit(composer, text, time = zonedDate(10, true)) {
  await composer.page.goto(`http://127.0.0.1:${appPort}/`)
  await composer.page.locator('#text').fill(text)
  await setScheduledTime(composer.page, time)
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

async function waitFor(text, timeoutMs = 600_000) {
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
  const stageRoot = mkdtempSync(join(tmpdir(), 'outbox-handbook-capture-'))
  tempRoots.push(stageRoot)
  outputRoot = join(stageRoot, 'screenshots')
  mkdirSync(outputRoot, { recursive: true })
  await startStub()
  await startApp()
  browser = await chromium.launch({ headless: true, args: ['--lang=en-GB'] })
  const composer = await context('OUTBOX')
  const approver = await context('ADMIN')

  await composer.page.goto(`http://127.0.0.1:${appPort}/`)
  const language = await composer.page.evaluate(() => navigator.language)
  if (language !== 'en-GB') fail(`Expected browser language en-GB before the blank form capture; got ${language}`)
  await setScheduledTime(composer.page, zonedDate(10))
  await capture(composer.page, '01-composer', '01-blank', ['Submit for approval', 'Preview'])

  const emptyAuthorPosts = await composer.context.newPage()
  await emptyAuthorPosts.goto(`http://127.0.0.1:${appPort}/posts`)
  await capture(emptyAuthorPosts, '05-posts', '03-empty-author', ['Posts', 'No posts yet.', 'Write a post'])
  const emptyApproverPosts = await approver.context.newPage()
  await emptyApproverPosts.goto(`http://127.0.0.1:${appPort}/posts`)
  await capture(emptyApproverPosts, '05-posts', '04-empty-approver', ['Posts', 'No posts yet.'])

  const clearDraft = 'The service update is ready for a careful review.'
  const clearReview = composer.page.waitForResponse((response) => response.url().endsWith('/api/review') && response.request().method() === 'POST')
  await composer.page.locator('#text').fill(clearDraft)
  await clearReview
  await composer.page.getByText('No blocking findings and no hints.', { exact: true }).waitFor()
  await capture(composer.page, '01-composer', '05-typing-clear', ['No blocking findings and no hints.', clearDraft])

  const blockedDraft = 'Everyone who joins this week gets guaranteed returns.'
  const blockedReview = composer.page.waitForResponse((response) => response.url().endsWith('/api/review') && response.request().method() === 'POST')
  await composer.page.locator('#text').fill(blockedDraft)
  await blockedReview
  await composer.page.getByText('Forbidden claim: guaranteed returns', { exact: true }).waitFor()
  await capture(composer.page, '01-composer', '06-typing-blocked', ['Forbidden claim: guaranteed returns', blockedDraft])

  const testPng = handbookPng()
  await composer.page.locator('#text').fill('A calm image accompanies this update.')
  const imageTextReview = composer.page.waitForResponse((response) => response.url().endsWith('/api/review') && response.request().method() === 'POST')
  await imageTextReview
  await composer.page.getByText('No blocking findings and no hints.', { exact: true }).waitFor()
  await composer.page.locator('#image').setInputFiles({ name: 'handbook-image.png', mimeType: 'image/png', buffer: testPng })
  await composer.page.locator('#image-preview:not([hidden])').waitFor()
  await capture(composer.page, '01-composer', '07-image-selected', ['Submit for approval'])

  await composer.page.locator('#image').setInputFiles({ name: 'handbook-image.txt', mimeType: 'text/plain', buffer: Buffer.from('not an image') })
  await composer.page.locator('#image-message').getByText('Choose a PNG or JPEG image.', { exact: true }).waitFor()
  const badImageNavigation = composer.page.waitForNavigation()
  await composer.page.locator('#submit-button').click()
  await badImageNavigation
  await capture(composer.page, '01-composer', '08-bad-image', ['Image must be a PNG or JPEG up to 5 MB.'])

  const noScriptContext = await browser.newContext({ viewport, deviceScaleFactor, locale: 'en-GB', timezoneId: 'Europe/Zurich', javaScriptEnabled: false, extraHTTPHeaders: { authorization: `Bearer ${jwt('OUTBOX')}` } })
  const droppedPage = await noScriptContext.newPage()
  await droppedPage.goto(`http://127.0.0.1:${appPort}/`)
  await droppedPage.locator('#text').fill(blockedDraft)
  await setScheduledTime(droppedPage, zonedDate(10))
  await droppedPage.locator('#image').setInputFiles({ name: 'handbook-image.png', mimeType: 'image/png', buffer: testPng })
  const droppedNavigation = droppedPage.waitForNavigation()
  await droppedPage.locator('#submit-button').click()
  await droppedNavigation
  await capture(droppedPage, '01-composer', '09-image-dropped', ['Blocking review finding.', 'Choose the image again — it was not kept.'])
  await noScriptContext.close()

  const noScriptBlockedContext = await browser.newContext({ viewport, deviceScaleFactor, locale: 'en-GB', timezoneId: 'Europe/Zurich', javaScriptEnabled: false, extraHTTPHeaders: { authorization: `Bearer ${jwt('OUTBOX')}` } })
  const serverBlockedPage = await noScriptBlockedContext.newPage()
  await serverBlockedPage.goto(`http://127.0.0.1:${appPort}/`)
  await serverBlockedPage.locator('#text').fill(blockedDraft)
  await setScheduledTime(serverBlockedPage, zonedDate(10))
  await Promise.all([serverBlockedPage.waitForNavigation(), serverBlockedPage.locator('button[type=submit]').click()])
  await capture(serverBlockedPage, '01-composer', '02-blocked', ['Blocking review finding.', 'Forbidden claim: guaranteed returns'])
  await noScriptBlockedContext.close()

  await composer.page.locator('#text').fill('A neutral post with a future review time.')
  await setScheduledTime(composer.page, zonedDate(-10))
  await Promise.all([composer.page.waitForNavigation(), composer.page.locator('button[type=submit]').click()])
  await capture(composer.page, '01-composer', '03-past-time', ['The scheduled time is already in the past.'])

  const clear = await submit(composer, 'A short update is scheduled after tomorrow’s review.')
  const clearApprover = await reviewPage(approver.context, clear.bundleId)
  await capture(clearApprover, '02-review-approver', '01-submitted-clear', ['submitted', 'Approve', 'Reject', 'No blocking findings and no hints.'])
  await capture(await reviewPage(composer.context, clear.bundleId), '03-review-author', '01-submitted-clear', ['submitted', 'No blocking findings and no hints.'])
  const imageDraft = 'A reference image is attached to this submitted update.'
  await composer.page.goto(`http://127.0.0.1:${appPort}/`)
  await composer.page.locator('#text').fill(imageDraft)
  await setScheduledTime(composer.page, zonedDate(10, true))
  await composer.page.locator('#image').setInputFiles({ name: 'handbook-image.png', mimeType: 'image/png', buffer: testPng })
  const imageSubmissionNavigation = composer.page.waitForNavigation()
  await composer.page.locator('#submit-button').click()
  await imageSubmissionNavigation
  const imageBundleId = /\/review\/([^/?]+)/.exec(composer.page.url())?.[1]
  if (!imageBundleId) fail('Image submission did not open its review page')
  const imageReview = await reviewPage(approver.context, decodeURIComponent(imageBundleId))
  await capture(imageReview, '02-review-approver', '11-submitted-image', ['submitted', imageDraft, 'Approve', 'Reject'])
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
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 6 * 60_000 + 5_000))
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
  const authorPosts = await composer.context.newPage()
  await authorPosts.goto(`http://127.0.0.1:${appPort}/posts`)
  await capture(authorPosts, '05-posts', '01-author-list', [
    'Posts', 'Waiting for approval.', 'Approved. Goes out at the scheduled time.',
    'Published on X.', 'Sending failed. An approver can retry.', 'Rejected by an approver.',
    'Image attached', 'View on X'
  ])
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
  await setScheduledTime(missingPackContext.page, zonedDate(10, true))
  await Promise.all([missingPackContext.page.waitForNavigation(), missingPackContext.page.locator('button[type=submit]').click()])
  await capture(missingPackContext.page, '01-composer', '04-pack-missing', ['Review pack is missing.'])
  await missingPackContext.context.close()
  app = originalApp
  appPort = originalAppPort

  const secondAuthor = await context('OUTBOX', 'handbook-second-author')
  const otherAuthorPost = await submit(secondAuthor, 'A separate author update for the approver list.')
  if (!otherAuthorPost.bundleId) fail('Second author submission did not open its review page')
  const approverPosts = await approver.context.newPage()
  await approverPosts.goto(`http://127.0.0.1:${appPort}/posts`)
  await capture(approverPosts, '05-posts', '02-approver-list', [
    'Posts', 'A separate author update for the approver list.', 'Open'
  ])

  await captureStaticErrors(composer, approver)

  const pngs = []
  const markdown = []
  for (const group of readdirSync(finalOutputRoot, { withFileTypes: true })) {
    if (!group.isDirectory()) continue
    for (const file of readdirSync(join(finalOutputRoot, group.name))) {
      const path = `${group.name}/${file}`
      if (file.toLowerCase().endsWith('.png')) continue
      if (file.toLowerCase().endsWith('.md') && file.toLowerCase() !== '_group.md') markdown.push(path)
    }
  }
  pngs.push(...pngPaths(outputRoot))
  const key = (path) => path.replace(/\.(png|md)$/i, '').toLowerCase()
  const pngKeys = new Set(pngs.map(key))
  const markdownKeys = new Set(markdown.map(key))
  const missing = pngs.filter((file) => !markdownKeys.has(key(file)))
  const unpaired = markdown.filter((file) => !pngKeys.has(key(file)))
  if (missing.length || unpaired.length) fail(`Capture pairs are incomplete. Missing text for: ${missing.join(', ')}. Missing images for: ${unpaired.join(', ')}`)
  const recordedPngs = written.map((path) => path.slice(outputRoot.length + 1)).sort()
  if (pngs.length === 0 || JSON.stringify(pngs.slice().sort()) !== JSON.stringify(recordedPngs)) fail(`Capture count is invalid: ${pngs.length} PNG files and ${recordedPngs.length} recorded captures`)
  const inputs = captureInputs()
  const inputHash = createHash('sha256')
  for (const input of inputs) inputHash.update(input).update('\0').update(readFileSync(join(repoRoot, input))).update('\0')
  const inputsSha256 = inputHash.digest('hex')
  const metadataPath = join(outputRoot, 'capture.json')
  writeFileSync(metadataPath, `${JSON.stringify({ inputs, inputsSha256, viewport: captureViewport, deviceScaleFactor, count: pngs.length }, null, 2)}\n`)
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'))
  if (!Array.isArray(metadata.inputs) || JSON.stringify(metadata.inputs) !== JSON.stringify(inputs) || metadata.inputsSha256 !== inputsSha256 || metadata.count !== pngs.length || !/^[a-f0-9]{64}$/.test(metadata.inputsSha256)) {
    fail('Staged capture.json failed validation')
  }
  written = pngs.map((path) => join(outputRoot, path))
  installStagedCapture(stageRoot, pngs, metadataPath)
  process.stdout.write(`Captured ${written.length} screenshots\n`)
}

try {
  await main()
} catch (error) {
  if (error?.preserveStageRoot) preservedStageRoot = error.preserveStageRoot
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
  for (const tempRoot of tempRoots) if (tempRoot !== preservedStageRoot) rmSync(tempRoot, { recursive: true, force: true })
}
