import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from 'node:http'
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
  renderComposerPage,
  renderPlainPage,
  renderReviewPage
} from './html'
import { hasRoleAccess, type Identity, type Introspect, type Role } from './identity'
import { createLog } from './log'
import { formatZurich, parseZurichDateTime } from './time'

export type OutboxServerDeps = {
  db: SqliteDatabase
  packRoot: string
  introspect: Introspect
  now?: () => number
  jwtSecret?: string
  brand?: string
  log?: (line: string) => void
  /** Wired in a later step to `GET /2/users/me`. Absent: the probe is `'bad'`. */
  probeX?: () => 'ok' | 'bad'
}

const COOKIE_NAME = 'outbox'
const COOKIE_MAX_AGE_SEC = 12 * 60 * 60
const BODY_LIMIT = 1_000_000
const DEFAULT_BRAND = 'dfx'

const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'",
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
}

const ENTRY_VIEW_SQL = `SELECT e.id, e.bundleId, e.state, e.text, e.scheduledAt, e.checks,
       b.authoredByUser, b.authoredByAccount
FROM entries e
JOIN bundles b ON b.id = e.bundleId`

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
  if (type === 'application/json') return true
  if (pathname.startsWith('/api/')) return true
  const accept = headerString(req.headers.accept) ?? ''
  return accept.includes('application/json')
}

function send(
  res: ServerResponse,
  status: number,
  body: string,
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

async function readBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = chunk as Buffer
    total += buf.length
    if (total > BODY_LIMIT) return null
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function parseFields(
  req: IncomingMessage
): Promise<{ ok: true; fields: Record<string, string> } | { ok: false; status: number; message: string }> {
  const raw = await readBody(req)
  if (raw === null) return { ok: false, status: 413, message: 'Request body is too large.' }
  const type = mediaType(req)
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
    return { ok: true, fields }
  }
  if (type === 'application/x-www-form-urlencoded' || type === '') {
    const fields: Record<string, string> = {}
    for (const [key, value] of new URLSearchParams(raw).entries()) fields[key] = value
    return { ok: true, fields }
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

export function createOutboxServer(deps: OutboxServerDeps): Server {
  const now = deps.now ?? (() => Date.now())
  const brand = deps.brand ?? DEFAULT_BRAND
  const log = createLog(deps.log ?? ((line) => process.stdout.write(line + '\n')))

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

    if (method === 'GET' && pathname === '/healthz') {
      const jwtOk = typeof deps.jwtSecret === 'string' && deps.jwtSecret !== ''
      const rulesOk = loadPackRules(deps.packRoot, brand) !== null
      const x: 'ok' | 'bad' = deps.probeX?.() ?? 'bad'
      const jwt: 'ok' | 'bad' = jwtOk ? 'ok' : 'bad'
      const ok = x === 'ok' && jwt === 'ok' && rulesOk
      sendJson(res, 200, {
        ok,
        queueRunning: false,
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
          scheduledAt: '',
          charCount: 0,
          costHint: costHint('')
        })
      )
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
      const posts = listEntries(deps.db, account).map((row) => ({
        bundleId: row.bundleId,
        entryId: row.id,
        state: row.state,
        text: row.text,
        scheduledAt: row.scheduledAt,
        authoredByAccount: row.authoredByAccount
      }))
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
          ? canDecide({ scheduledAt: row.scheduledAt, checks: row.checks }, now())
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
          approver: auth.identity.role === 'ADMIN'
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
    if (!submitPost && !reviewPost && !retractMatch && !decideMatch) {
      await readBody(req)
      fail(res, req, pathname, 404, 'not-found', 'Not found.')
      return
    }

    const neededRole: Role = decideMatch ? 'ADMIN' : 'OUTBOX'
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
      if (text.trim() === '') {
        fail(res, req, pathname, 400, 'invalid-request', 'Text is required.')
        return
      }
      const reviewed = reviewText(deps.packRoot, brand, text)
      if (!reviewed.ok) {
        sendJson(res, 409, { ok: false, reason: 'missing-pack', detail: 'Review pack is missing.' })
        return
      }
      sendJson(res, 200, {
        ok: true,
        blocking: reviewed.checks.blocking,
        hints: reviewed.checks.hints ?? []
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
      const scheduledRaw = parsed.fields.scheduledAt ?? ''
      if (text.trim() === '') {
        fail(res, req, pathname, 400, 'invalid-request', 'Text is required.')
        return
      }
      const scheduledAt = parseZurichDateTime(scheduledRaw)
      if (scheduledAt === null) {
        fail(res, req, pathname, 400, 'invalid-request', 'scheduledAt must be datetime-local in Europe/Zurich.')
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
            scheduledAt: scheduledRaw,
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
            scheduledAt: scheduledRaw,
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
            scheduledAt: scheduledRaw,
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
