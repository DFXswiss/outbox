import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from 'node:http'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { writeAudit } from './audit'
import type { SqliteDatabase } from './db'
import {
  canDecide,
  decideEntry,
  parseChecks,
  retractBundle,
  submitSubmission
} from './entries'
import { characterCount, costHint, loadPackRules, reviewText } from './findings'
import {
  authorStatusMessage,
  renderComposerPage,
  renderPlainPage,
  renderPostsPage,
  renderReviewPage
} from './html'
import { hasRoleAccess, type Identity, type Introspect, type Role } from './identity'
import { IMAGE_LIMIT, imageMime } from './image'
import { createLog } from './log'
import { resolveUncertain, retryPost } from './queue'
import { formatZurich, nextSlotZurich, parseZurichDateTime } from './time'

export type OutboxServerDeps = {
  db: SqliteDatabase
  packRoot: string
  brand: string
  introspect: Introspect
  now?: () => number
  jwtSecret?: string
  log?: (line: string) => void
  /** Wired to the publisher's X probe state. Absent: the probe is `'bad'`. */
  probeX?: () => 'ok' | 'bad'
  publisher?: { running(): boolean }
}

const COOKIE_NAME = 'outbox'
const COOKIE_MAX_AGE_SEC = 12 * 60 * 60
const BODY_LIMIT = 1_000_000
const MULTIPART_LIMIT = 6 * 1024 * 1024
const ResolveInputSchema = z.object({
  resolution: z.enum(['sent', 'failed']),
  url: z.string().optional()
}).strict()

const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy':
    "default-src 'none'; script-src 'self'; connect-src 'self'; img-src 'self' blob:; style-src 'unsafe-inline'; font-src 'self'; form-action 'self'; base-uri 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex, nofollow',
  'cache-control': 'private, no-store'
}

type EntryView = {
  id: string
  bundleId: string
  state: string
  text: string
  scheduledAt: number
  checks: string | null
  authoredByUser: string
  authoredByAccount: string
  postId: string | null
  channel: string | null
  channelStatus: string | null
  postUrl: string | null
  imageSha256: string | null
}

const ENTRY_VIEW_SQL = `SELECT e.id, e.bundleId, e.state, e.text, e.scheduledAt, e.checks, e.imageSha256,
       b.authoredByUser, b.authoredByAccount, p.id AS postId, p.channel,
       p.status AS channelStatus, p.url AS postUrl
FROM entries e
JOIN bundles b ON b.id = e.bundleId
LEFT JOIN scheduled_posts p ON p.entryId = e.id`

function headerString(value: string | string[] | undefined): string | null {
  if (typeof value === 'string' && value !== '') return value
  if (Array.isArray(value) && typeof value[0] === 'string' && value[0] !== '') return value[0]
  return null
}

function mediaType(req: IncomingMessage): string {
  const raw = headerString(req.headers['content-type']) ?? ''
  return raw.split(';')[0]!.trim().toLowerCase()
}

function wantsJson(req: IncomingMessage, pathname: string): boolean {
  const type = mediaType(req)
  if (type === 'application/x-www-form-urlencoded') return false
  if (type === 'multipart/form-data') {
    const accept = headerString(req.headers.accept) ?? ''
    if (accept.includes('text/html')) return false
    if (accept.includes('application/json')) return true
    return pathname.startsWith('/api/')
  }
  if (type === 'application/json') return true
  if (pathname.startsWith('/api/')) return true
  const accept = headerString(req.headers.accept) ?? ''
  return accept.includes('application/json')
}

function send(
  res: ServerResponse,
  status: number,
  body: string | Buffer,
  headers: Record<string, string>
): void {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers })
  res.end(body)
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  send(res, status, html, { 'content-type': 'text/html; charset=utf-8' })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  send(res, status, JSON.stringify(body), { 'content-type': 'application/json; charset=utf-8' })
}

/**
 * Working-session Set-Cookie. Issue this only after introspect returned
 * 200 — never from a raw query token, and not before TOTP has passed.
 */
export function sessionCookie(token: string): string {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; Max-Age=${COOKIE_MAX_AGE_SEC}; HttpOnly; Secure; SameSite=Strict`
}

function readCookie(req: IncomingMessage, name: string): string | null {
  const header = headerString(req.headers.cookie)
  if (!header) return null
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name) {
      try {
        return decodeURIComponent(rest.join('='))
      } catch {
        return null
      }
    }
  }
  return null
}

function tokenFromRequest(
  req: IncomingMessage
): { token: string; via: 'bearer' | 'cookie' } | null {
  const auth = headerString(req.headers.authorization)
  if (auth) {
    const match = /^Bearer\s+(\S+)/i.exec(auth)
    if (match && match[1]) return { token: match[1], via: 'bearer' }
  }
  const cookie = readCookie(req, COOKIE_NAME)
  if (cookie !== null && cookie !== '') return { token: cookie, via: 'cookie' }
  return null
}

function requestOriginHost(req: IncomingMessage): string | null {
  const origin = headerString(req.headers.origin)
  if (origin && origin !== 'null') {
    try {
      return new URL(origin).host.toLowerCase()
    } catch {
      return null
    }
  }
  const referer = headerString(req.headers.referer)
  if (referer) {
    try {
      return new URL(referer).host.toLowerCase()
    } catch {
      return null
    }
  }
  return null
}

function originMatchesHost(req: IncomingMessage): boolean {
  const host = headerString(req.headers.host)
  if (!host) return false
  const from = requestOriginHost(req)
  if (!from) return false
  return from === host.toLowerCase()
}

async function readBodyBytes(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    total += buf.length
    if (total > limit) return null
    chunks.push(buf)
  }
  return Buffer.concat(chunks)
}

async function readBody(req: IncomingMessage): Promise<string | null> {
  const bytes = await readBodyBytes(req, BODY_LIMIT)
  return bytes === null ? null : bytes.toString('utf8')
}

async function parseFields(
  req: IncomingMessage
): Promise<{ ok: true; fields: Record<string, string>; imageBytes: Buffer | null } | { ok: false; status: number; message: string }> {
  const type = mediaType(req)
  if (type === 'multipart/form-data') {
    const contentType = headerString(req.headers['content-type']) ?? ''
    const rawBytes = await readBodyBytes(req, MULTIPART_LIMIT)
    if (rawBytes === null) return { ok: false, status: 413, message: 'Request body is too large.' }
    try {
      const form = await new Request('http://localhost/', {
        method: 'POST', headers: { 'content-type': contentType }, body: rawBytes
      }).formData()
      const fields: Record<string, string> = {}
      const images = form.getAll('image')
      if (images.length > 1) return { ok: false, status: 400, message: 'Only one image may be attached.' }
      for (const [key, value] of form.entries()) {
        if (key === 'image') continue
        if (typeof value !== 'string') return { ok: false, status: 400, message: 'Form fields must be text.' }
        fields[key] = value
      }
      const image = images[0]
      if (image !== undefined && typeof image !== 'string') {
        const bytes = Buffer.from(await image.arrayBuffer())
        return { ok: true, fields, imageBytes: bytes.length === 0 ? null : bytes }
      }
      return { ok: true, fields, imageBytes: null }
    } catch {
      return { ok: false, status: 400, message: 'Invalid multipart form data.' }
    }
  }
  const raw = await readBody(req)
  if (raw === null) return { ok: false, status: 413, message: 'Request body is too large.' }
  if (type === 'application/json') {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw === '' ? '{}' : raw)
    } catch {
      return { ok: false, status: 400, message: 'Invalid JSON.' }
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, status: 400, message: 'Invalid JSON.' }
    }
    const fields: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value === undefined) continue
      if (typeof value !== 'string') {
        return { ok: false, status: 400, message: 'JSON fields must be strings.' }
      }
      fields[key] = value
    }
    return { ok: true, fields, imageBytes: null }
  }
  if (type === 'application/x-www-form-urlencoded' || type === '') {
    const fields: Record<string, string> = {}
    for (const [key, value] of new URLSearchParams(raw).entries()) fields[key] = value
    return { ok: true, fields, imageBytes: null }
  }
  return { ok: false, status: 415, message: 'Unsupported Content-Type.' }
}

function loadEntryByBundle(db: SqliteDatabase, bundleId: string): EntryView | null {
  const rows = db.prepare(`${ENTRY_VIEW_SQL} WHERE e.bundleId = ?`).all(bundleId) as EntryView[]
  return rows[0] ?? null
}

function listEntries(db: SqliteDatabase, account: string | null): EntryView[] {
  if (account === null) {
    return db.prepare(`${ENTRY_VIEW_SQL} ORDER BY e.scheduledAt ASC`).all() as EntryView[]
  }
  return db
    .prepare(`${ENTRY_VIEW_SQL} WHERE b.authoredByAccount = ? ORDER BY e.scheduledAt ASC`)
    .all(account) as EntryView[]
}

function isVisible(identity: Identity, row: EntryView): boolean {
  if (identity.role === 'ADMIN') return true
  return row.authoredByAccount === identity.account
}

function scheduledInput(fields: Record<string, string>): { raw: string; values: { scheduledDate: string; scheduledHour: string; scheduledMinute: string } } | null {
  const scheduledAt = fields.scheduledAt ?? ''
  if (scheduledAt !== '') {
    const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(scheduledAt)
    if (!match) return null
    return { raw: `${match[1]}T${match[2]}:${match[3]}${match[4] ? `:${match[4]}` : ''}`, values: { scheduledDate: match[1]!, scheduledHour: match[2]!, scheduledMinute: match[3]! } }
  }
  const date = fields.scheduledDate ?? ''
  const hour = fields.scheduledHour ?? ''
  const minute = fields.scheduledMinute ?? ''
  if (!date || !hour || !minute) return null
  return { raw: `${date}T${hour}:${minute}`, values: { scheduledDate: date, scheduledHour: hour, scheduledMinute: minute } }
}

function validImage(bytes: Buffer | null): boolean {
  if (bytes === null) return true
  return bytes.length <= IMAGE_LIMIT && imageMime(bytes) !== null
}

export function createOutboxServer(deps: OutboxServerDeps): Server {
  const now = deps.now ?? (() => Date.now())
  const brand = deps.brand
  const log = createLog(deps.log ?? ((line) => process.stdout.write(line + '\n')))
  const fontDirectory = join(dirname(fileURLToPath(import.meta.url)), 'assets', 'fonts')
  const fontNames = new Set(
    readdirSync(fontDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.woff2'))
      .map((entry) => entry.name)
  )

  async function authenticate(
    req: IncomingMessage,
    role: Role
  ): Promise<
    | { ok: true; identity: Identity; token: string; via: 'bearer' | 'cookie' }
    | { ok: false; status: number }
  > {
    const presented = tokenFromRequest(req)
    if (presented === null) return { ok: false, status: 401 }
    const result = await deps.introspect(presented.token, role)
    if (!result.ok) return { ok: false, status: result.status }
    if (!hasRoleAccess(role, result.role)) return { ok: false, status: 403 }
    return { ok: true, identity: result, token: presented.token, via: presented.via }
  }

  function refuseOrigin(
    res: ServerResponse,
    req: IncomingMessage,
    identity: Identity,
    asJson: boolean
  ): void {
    writeAudit(deps.db, {
      at: now(),
      event: 'refused',
      bundleId: null,
      entryId: null,
      actorUser: identity.user,
      actorAccount: identity.account,
      reason: 'origin-mismatch'
    })
    const message = 'Origin does not match this host.'
    if (asJson) sendJson(res, 403, { ok: false, reason: 'origin-mismatch', detail: message })
    else sendHtml(res, 403, renderPlainPage('Forbidden', message))
  }

  function fail(
    res: ServerResponse,
    req: IncomingMessage,
    pathname: string,
    status: number,
    reason: string,
    detail: string,
    extra: Record<string, unknown> = {}
  ): void {
    if (wantsJson(req, pathname)) {
      sendJson(res, status, { ok: false, reason, detail, ...extra })
      return
    }
    sendHtml(res, status, renderPlainPage(status === 401 ? 'Sign in required' : 'Request failed', detail))
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = headerString(req.headers.host) ?? 'localhost'
    const url = new URL(req.url ?? '/', `http://${host}`)
    const pathname = url.pathname
    const method = req.method ?? 'GET'
    const authHeader = headerString(req.headers.authorization)
    const cookieHeaderValue = headerString(req.headers.cookie)
    const logParts = [`${method} ${pathname}`]
    if (authHeader) logParts.push(`Authorization: ${authHeader}`)
    if (cookieHeaderValue) logParts.push(`Cookie: ${cookieHeaderValue}`)
    log(logParts.join(' '))

    const fontRoute = /^\/assets\/fonts\/([^/]+)$/.exec(pathname)
    if (method === 'GET' && fontRoute && fontNames.has(fontRoute[1]!)) {
      send(res, 200, readFileSync(join(fontDirectory, fontRoute[1]!)), {
        'content-type': 'font/woff2',
        'cache-control': 'public, max-age=31536000, immutable'
      })
      return
    }

    if (method === 'GET' && pathname === '/assets/composer.js') {
      const assetPath = join(dirname(fileURLToPath(import.meta.url)), 'assets', 'composer.js')
      send(res, 200, readFileSync(assetPath), { 'content-type': 'text/javascript; charset=utf-8' })
      return
    }

    if (method === 'GET' && pathname === '/healthz') {
      const jwtOk = typeof deps.jwtSecret === 'string' && deps.jwtSecret !== ''
      const rulesOk = loadPackRules(deps.packRoot, brand) !== null
      const x: 'ok' | 'bad' = deps.probeX?.() ?? 'bad'
      const jwt: 'ok' | 'bad' = jwtOk ? 'ok' : 'bad'
      const ok = x === 'ok' && jwt === 'ok' && rulesOk
      sendJson(res, 200, {
        ok,
        queueRunning: deps.publisher?.running() ?? false,
        probes: { x, jwt }
      })
      return
    }

    if (method === 'GET' && pathname === '/') {
      const auth = await authenticate(req, 'OUTBOX')
      if (!auth.ok) {
        fail(res, req, pathname, auth.status, 'auth-failed', 'Sign in required.')
        return
      }
      sendHtml(
        res,
        200,
        renderComposerPage({
          text: '',
          ...nextSlotZurich(now()),
          charCount: 0,
          costHint: costHint('')
        })
      )
      return
    }

    if (method === 'GET' && pathname === '/posts') {
      const auth = await authenticate(req, 'OUTBOX')
      if (!auth.ok) {
        fail(res, req, pathname, auth.status, 'auth-failed', 'Sign in required.')
        return
      }
      const rows = [...listEntries(deps.db, auth.identity.role === 'ADMIN' ? null : auth.identity.account)].reverse()
      sendHtml(res, 200, renderPostsPage({
        author: auth.identity.role !== 'ADMIN',
        posts: rows.map((row) => ({
          bundleId: row.bundleId,
          state: row.state,
          text: row.text,
          scheduledLabel: formatZurich(row.scheduledAt),
          channel: row.postId === null ? null : { postId: row.postId, status: row.channelStatus!, url: row.postUrl },
          imageSha256: row.imageSha256,
          authorMessage: authorStatusMessage(row.state, row.channelStatus)
        }))
      }))
      return
    }

    const mediaMatch = /^\/media\/([a-f0-9]{64})$/.exec(pathname)
    if (method === 'GET' && mediaMatch) {
      const auth = await authenticate(req, 'OUTBOX')
      if (!auth.ok) {
        fail(res, req, pathname, auth.status, 'auth-failed', 'Sign in required.')
        return
      }
      const sha256 = mediaMatch[1]!
      const references = deps.db.prepare(`${ENTRY_VIEW_SQL} WHERE e.imageSha256 = ?`).all(sha256) as EntryView[]
      if (!references.some((row) => isVisible(auth.identity, row))) {
        sendJson(res, 404, { ok: false, reason: 'not-found', detail: 'Not found.' })
        return
      }
      const media = deps.db.prepare('SELECT mime, bytes FROM media WHERE sha256 = ?').get(sha256) as { mime: string; bytes: Buffer } | undefined
      if (!media) {
        sendJson(res, 404, { ok: false, reason: 'not-found', detail: 'Not found.' })
        return
      }
      send(res, 200, media.bytes, { 'content-type': media.mime, 'x-content-type-options': 'nosniff', 'cache-control': 'private, no-store' })
      return
    }

    if (method === 'GET' && pathname === '/api/me') {
      const auth = await authenticate(req, 'OUTBOX')
      if (!auth.ok) {
        fail(res, req, pathname, auth.status, 'auth-failed', 'Sign in required.')
        return
      }
      sendJson(res, 200, {
        account: auth.identity.account,
        user: auth.identity.user,
        role: auth.identity.role
      })
      return
    }

    if (method === 'GET' && pathname === '/api/posts') {
      const auth = await authenticate(req, 'OUTBOX')
      if (!auth.ok) {
        fail(res, req, pathname, auth.status, 'auth-failed', 'Sign in required.')
        return
      }
      const account = auth.identity.role === 'ADMIN' ? null : auth.identity.account
      const posts = listEntries(deps.db, account).map((row) => {
        const channel = row.postId === null
          ? null
          : {
              postId: row.postId,
              channel: row.channel!,
              status: row.channelStatus!,
              url: row.postUrl
            }
        return {
          bundleId: row.bundleId,
          entryId: row.id,
          state: row.state,
          text: row.text,
          scheduledAt: row.scheduledAt,
          authoredByAccount: row.authoredByAccount,
          channel
        }
      })
      sendJson(res, 200, { posts })
      return
    }

    const reviewGet = /^\/review\/([^/]+)$/.exec(pathname)
    if (method === 'GET' && reviewGet) {
      const auth = await authenticate(req, 'OUTBOX')
      if (!auth.ok) {
        fail(res, req, pathname, auth.status, 'auth-failed', 'Sign in required.')
        return
      }
      const bundleId = reviewGet[1]!
      const row = loadEntryByBundle(deps.db, bundleId)
      if (!row) {
        fail(res, req, pathname, 404, 'not-found', 'Not found.')
        return
      }
      if (!isVisible(auth.identity, row)) {
        fail(res, req, pathname, 403, 'forbidden', 'Not visible.')
        return
      }
      const recorded = parseChecks(row.checks)
      const lockReason =
        row.state === 'submitted'
          ? canDecide(
              { scheduledAt: row.scheduledAt, checks: row.checks },
              now()
            )
          : null
      sendHtml(
        res,
        200,
        renderReviewPage({
          bundleId: row.bundleId,
          text: row.text,
          scheduledLabel: formatZurich(row.scheduledAt),
          state: row.state,
          recorded,
          lockReason,
          approver: auth.identity.role === 'ADMIN',
          channel: row.postId === null
            ? null
            : {
                postId: row.postId,
                channel: row.channel!,
                status: row.channelStatus!,
                url: row.postUrl
              },
          imageSha256: row.imageSha256,
          authorMessage: authorStatusMessage(row.state, row.channelStatus)
        })
      )
      return
    }

    if (method !== 'POST') {
      fail(res, req, pathname, 404, 'not-found', 'Not found.')
      return
    }

    const submitPost = pathname === '/api/submit'
    const reviewPost = pathname === '/api/review'
    const retractMatch = /^\/api\/bundles\/([^/]+)\/retract$/.exec(pathname)
    const decideMatch = /^\/review\/([^/]+)\/decide$/.exec(pathname)
    const retryMatch = /^\/api\/posts\/([^/]+)\/retry$/.exec(pathname)
    const resolveMatch = /^\/api\/posts\/([^/]+)\/resolve-uncertain$/.exec(pathname)
    if (
      !submitPost &&
      !reviewPost &&
      !retractMatch &&
      !decideMatch &&
      !retryMatch &&
      !resolveMatch
    ) {
      await readBody(req)
      fail(res, req, pathname, 404, 'not-found', 'Not found.')
      return
    }

    const neededRole: Role = decideMatch || retryMatch || resolveMatch
      ? 'ADMIN'
      : 'OUTBOX'
    const auth = await authenticate(req, neededRole)
    if (!auth.ok) {
      await readBody(req)
      fail(res, req, pathname, auth.status, 'auth-failed', 'Not allowed.')
      return
    }
    if (auth.via === 'cookie' && !originMatchesHost(req)) {
      await readBody(req)
      refuseOrigin(res, req, auth.identity, wantsJson(req, pathname))
      return
    }

    if (reviewPost) {
      const parsed = await parseFields(req)
      if (!parsed.ok) {
        fail(res, req, pathname, parsed.status, 'invalid-request', parsed.message)
        return
      }
      const text = parsed.fields.text ?? ''
      const reviewed = reviewText(deps.packRoot, brand, text)
      if (!reviewed.ok) {
        sendJson(res, 409, { ok: false, reason: 'missing-pack', detail: 'Review pack is missing.' })
        return
      }
      sendJson(res, 200, {
        ok: true,
        blocking: reviewed.checks.blocking,
        hints: reviewed.checks.hints ?? [],
        charCount: characterCount(text),
        costHint: costHint(text)
      })
      return
    }

    if (submitPost) {
      const parsed = await parseFields(req)
      if (!parsed.ok) {
        fail(res, req, pathname, parsed.status, 'invalid-request', parsed.message)
        return
      }
      const text = parsed.fields.text ?? ''
      const timeInput = scheduledInput(parsed.fields)
      const timeFields = timeInput?.values ?? {
        scheduledDate: parsed.fields.scheduledDate ?? parsed.fields.scheduledAt?.slice(0, 10) ?? '',
        scheduledHour: parsed.fields.scheduledHour ?? parsed.fields.scheduledAt?.slice(11, 13) ?? '',
        scheduledMinute: parsed.fields.scheduledMinute ?? parsed.fields.scheduledAt?.slice(14, 16) ?? ''
      }
      if (text.trim() === '') {
        const detail = 'Text is required.'
        if (wantsJson(req, pathname)) fail(res, req, pathname, 400, 'invalid-request', detail)
        else sendHtml(res, 400, renderComposerPage({ text, ...timeFields, imageDropped: parsed.imageBytes !== null, error: detail, charCount: 0, costHint: costHint(text) }))
        return
      }
      const scheduledAt = timeInput ? parseZurichDateTime(timeInput.raw) : null
      if (scheduledAt === null) {
        const detail = 'Provide a valid scheduled time in Europe/Zurich.'
        if (wantsJson(req, pathname)) fail(res, req, pathname, 400, 'invalid-request', detail)
        else sendHtml(res, 400, renderComposerPage({ text, ...timeFields, imageDropped: parsed.imageBytes !== null, error: detail, charCount: characterCount(text), costHint: costHint(text) }))
        return
      }
      if (scheduledAt % 60_000 !== 0 || Number(timeInput!.values.scheduledMinute) % 5 !== 0) {
        const detail = 'Scheduled time must be on a 5-minute step.'
        if (wantsJson(req, pathname)) fail(res, req, pathname, 400, 'invalid-request', detail)
        else sendHtml(res, 400, renderComposerPage({ text, ...timeFields, imageDropped: parsed.imageBytes !== null, error: detail, charCount: characterCount(text), costHint: costHint(text) }))
        return
      }
      if (!validImage(parsed.imageBytes)) {
        if (wantsJson(req, pathname)) {
          sendJson(res, 409, { ok: false, reason: 'bad-image', detail: 'Image must be a PNG or JPEG up to 5 MB.' })
        } else {
          sendHtml(res, 409, renderComposerPage({ text, ...timeFields, imageDropped: parsed.imageBytes !== null, error: 'Image must be a PNG or JPEG up to 5 MB.', charCount: characterCount(text), costHint: costHint(text) }))
        }
        return
      }

      const reviewed = reviewText(deps.packRoot, brand, text)
      if (!reviewed.ok) {
        writeAudit(deps.db, {
          at: now(),
          event: 'refused',
          bundleId: null,
          entryId: null,
          actorUser: auth.identity.user,
          actorAccount: auth.identity.account,
          reason: 'missing-pack'
        })
        if (wantsJson(req, pathname)) {
          sendJson(res, 409, { ok: false, reason: 'missing-pack', detail: 'Review pack is missing.' })
          return
        }
        sendHtml(
          res,
          409,
          renderComposerPage({
            text,
            ...timeFields,
            imageDropped: parsed.imageBytes !== null,
            error: 'Review pack is missing.',
            recorded: null,
            charCount: characterCount(text),
            costHint: costHint(text)
          })
        )
        return
      }
      if (reviewed.checks.blocking.length > 0) {
        writeAudit(deps.db, {
          at: now(),
          event: 'refused',
          bundleId: null,
          entryId: null,
          actorUser: auth.identity.user,
          actorAccount: auth.identity.account,
          reason: 'blocking-review'
        })
        if (wantsJson(req, pathname)) {
          sendJson(res, 409, {
            ok: false,
            reason: 'blocking-review',
            blocking: reviewed.checks.blocking,
            hints: reviewed.checks.hints ?? []
          })
          return
        }
        sendHtml(
          res,
          409,
          renderComposerPage({
            text,
            ...timeFields,
            imageDropped: parsed.imageBytes !== null,
            error: 'Blocking review finding.',
            recorded: reviewed.checks,
            charCount: characterCount(text),
            costHint: costHint(text)
          })
        )
        return
      }

      const created = submitSubmission(deps.db, {
        text,
        scheduledAt,
        checks: reviewed.checks,
        imageBytes: parsed.imageBytes,
        actor: { user: auth.identity.user, account: auth.identity.account },
        now: now()
      })
      if (!created.ok) {
        const detail = 'The scheduled time is already in the past.'
        if (wantsJson(req, pathname)) {
          sendJson(res, 409, { ok: false, reason: created.reason, detail })
          return
        }
        sendHtml(
          res,
          409,
          renderComposerPage({
            text,
            ...timeFields,
            imageDropped: parsed.imageBytes !== null,
            error: detail,
            recorded: reviewed.checks,
            charCount: characterCount(text),
            costHint: costHint(text)
          })
        )
        return
      }

      if (wantsJson(req, pathname)) {
        sendJson(res, 200, {
          ok: true,
          bundleId: created.bundleId,
          entryId: created.entryId
        })
        return
      }
      res.writeHead(303, {
        location: `/review/${encodeURIComponent(created.bundleId)}`,
        ...SECURITY_HEADERS
      })
      res.end()
      return
    }

    if (retractMatch) {
      await readBody(req)
      const bundleId = retractMatch[1]!
      const row = loadEntryByBundle(deps.db, bundleId)
      if (!row) {
        fail(res, req, pathname, 404, 'not-found', 'Not found.')
        return
      }
      if (row.authoredByAccount !== auth.identity.account) {
        fail(res, req, pathname, 403, 'forbidden', 'Only the author can retract.')
        return
      }
      const result = retractBundle(deps.db, {
        bundleId,
        actor: { user: auth.identity.user, account: auth.identity.account },
        now: now()
      })
      if (!result.ok) {
        fail(res, req, pathname, 409, 'conflict', 'Retract conflict.')
        return
      }
      sendJson(res, 200, { ok: true })
      return
    }

    if (decideMatch) {
      const bundleId = decideMatch[1]!
      const parsed = await parseFields(req)
      if (!parsed.ok) {
        fail(res, req, pathname, parsed.status, 'invalid-request', parsed.message)
        return
      }
      const decision = parsed.fields.decision
      if (decision !== 'approve' && decision !== 'reject') {
        fail(res, req, pathname, 400, 'invalid-request', 'decision must be approve or reject.')
        return
      }
      const rows = deps.db
        .prepare(`${ENTRY_VIEW_SQL} WHERE e.bundleId = ?`)
        .all(bundleId) as EntryView[]
      if (rows.length === 0) {
        fail(res, req, pathname, 404, 'not-found', 'Not found.')
        return
      }
      if (rows.length !== 1) {
        fail(res, req, pathname, 409, 'conflict', 'Bundle does not have a single entry.')
        return
      }
      const row = rows[0]!
      const result = decideEntry(deps.db, {
        entryId: row.id,
        decision,
        actor: { user: auth.identity.user, account: auth.identity.account },
        now: now()
      })
      if (!result.ok) {
        if (result.reason === 'not-approvable') {
          fail(res, req, pathname, 409, result.reason, result.detail)
          return
        }
        fail(res, req, pathname, 409, result.reason, 'Decide conflict.')
        return
      }
      if (wantsJson(req, pathname)) {
        sendJson(res, 200, { ok: true, state: result.state })
        return
      }
      sendHtml(
        res,
        200,
        renderPlainPage('Decided', result.state === 'approved' ? 'Approved and queued.' : 'Rejected.')
      )
      return
    }

    if (retryMatch || resolveMatch) {
      const postId = (retryMatch ?? resolveMatch)![1]!
      const known = deps.db.prepare('SELECT id FROM scheduled_posts WHERE id = ?').get(postId)
      if (!known) {
        fail(res, req, pathname, 404, 'not-found', 'Not found.')
        return
      }
      let result: ReturnType<typeof retryPost> | ReturnType<typeof resolveUncertain>
      if (retryMatch) {
        await readBody(req)
        result = retryPost(deps.db, {
          postId,
          actor: {
            user: auth.identity.user,
            account: auth.identity.account
          },
          now: now()
        })
      } else {
        const parsed = await parseFields(req)
        if (!parsed.ok) {
          fail(res, req, pathname, parsed.status, 'invalid-request', parsed.message)
          return
        }
        const body = ResolveInputSchema.safeParse(parsed.fields)
        if (!body.success) {
          fail(
            res,
            req,
            pathname,
            400,
            'invalid-request',
            'Provide resolution and an optional url.'
          )
          return
        }
        const { resolution } = body.data
        const targetUrl = body.data.url?.trim() || undefined
        let normalizedUrl: string | undefined
        if (resolution === 'failed' && targetUrl !== undefined) {
          fail(
            res,
            req,
            pathname,
            400,
            'invalid-request',
            'url is allowed only when resolution is sent.'
          )
          return
        }
        if (targetUrl !== undefined) {
          let parsedUrl: URL
          try {
            parsedUrl = new URL(targetUrl)
          } catch {
            fail(
              res,
              req,
              pathname,
              400,
              'invalid-request',
              'url must be an X post URL.'
            )
            return
          }
          if (
            parsedUrl.protocol !== 'https:' ||
            parsedUrl.username !== '' ||
            parsedUrl.password !== '' ||
            parsedUrl.port !== '' ||
            ![
              'x.com',
              'www.x.com',
              'mobile.x.com',
              'twitter.com',
              'www.twitter.com',
              'mobile.twitter.com'
            ].includes(parsedUrl.hostname.toLowerCase()) ||
            !/^\/(?:[A-Za-z0-9_]{1,15}\/status\/\d+|i\/web\/status\/\d+)\/?$/.test(
              parsedUrl.pathname
            )
          ) {
            fail(
              res,
              req,
              pathname,
              400,
              'invalid-request',
              'url must be an X post URL.'
            )
            return
          }
          normalizedUrl = `${parsedUrl.origin}${parsedUrl.pathname}`
        }
        result = resolveUncertain(deps.db, {
          postId,
          resolution,
          ...(normalizedUrl !== undefined ? { url: normalizedUrl } : {}),
          actor: {
            user: auth.identity.user,
            account: auth.identity.account
          },
          now: now()
        })
      }
      if (!result.ok) {
        fail(res, req, pathname, 409, 'conflict', 'Post status conflict.')
        return
      }
      if (wantsJson(req, pathname)) {
        sendJson(res, 200, { ok: true, status: result.status })
        return
      }
      sendHtml(
        res,
        200,
        renderPlainPage('Post updated', `Post status: ${result.status}.`)
      )
      return
    }
  }

  return createServer((req, res) => {
    handle(req, res).catch(() => {
      if (res.headersSent) {
        res.end()
        return
      }
      sendHtml(res, 500, renderPlainPage('Error', 'Internal error.'))
    })
  })
}
