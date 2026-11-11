import { createHmac } from 'node:crypto'
import { chmodSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { parseZurichDateTime } from '../../src/time'
import type { SqliteDatabase } from '../../src/db'

export function redactKnownSecrets(value: string, secrets: Iterable<string>): string {
  let result = value
  const ordered = [...new Set([...secrets].filter((secret) => secret.length > 0))]
    .sort((left, right) => right.length - left.length)
  for (const secret of ordered) result = result.split(secret).join('[redacted]')
  return result.replace(/[\r\n\t]+/g, ' ')
}

export function duplicateContentFailure(db: SqliteDatabase, postId: string, secrets: Iterable<string>): string | null {
  const row = db.prepare(
    'SELECT error FROM publish_results WHERE scheduledPostId = ? ORDER BY at DESC, rowid DESC LIMIT 1'
  ).get(postId) as { error: string | null } | undefined
  if (row?.error && /duplicate content/i.test(row.error)) return null
  return unexpectedPostStatus(db, postId, 'failed', secrets)
}

export function unexpectedPostStatus(
  db: SqliteDatabase,
  postId: string,
  status: 'failed' | 'uncertain',
  secrets: Iterable<string>
): string {
  const row = db.prepare(
    'SELECT error FROM publish_results WHERE scheduledPostId = ? ORDER BY at DESC, rowid DESC LIMIT 1'
  ).get(postId) as { error: string | null } | undefined
  const detail = row?.error || 'No stored error detail'
  return redactKnownSecrets(`X publish ${status}: ${detail}`, secrets)
}

export function parseEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (match) result[match[1]!] = match[2]!.replace(/^(["'])(.*)\1$/, '$2')
  }
  return result
}

export function readPrivateEnv(path: string): Record<string, string> {
  if ((statSync(path).mode & 0o777) !== 0o600) throw new Error('X environment file must have mode 600')
  return parseEnv(readFileSync(path, 'utf8'))
}

export function saveRefreshToken(path: string, token: string): void {
  if ((statSync(path).mode & 0o777) !== 0o600 || !token || /[\r\n]/.test(token)) throw new Error('Cannot safely store X refresh token')
  const lines = readFileSync(path, 'utf8').split(/\r?\n/).filter((line) => !/^\s*(?:export\s+)?X_REFRESH_TOKEN\s*=/.test(line))
  while (lines.at(-1) === '') lines.pop()
  lines.push(`X_REFRESH_TOKEN=${token}`)
  writeFileSync(path, `${lines.join('\n')}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
}

export function totp(secret: string, epochMs: number, digits = 6): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = ''
  for (const char of secret.toUpperCase().replace(/[=\s]/g, '')) {
    const index = alphabet.indexOf(char)
    if (index < 0) throw new Error('Invalid TOTP secret')
    bits += index.toString(2).padStart(5, '0')
  }
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)))
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(epochMs / 30_000)))
  const mac = createHmac('sha1', key).update(counter).digest()
  const offset = mac[mac.length - 1]! & 15
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits).padStart(digits, '0')
}

export function findMailOtp(content: string, offset: number, mail: string): string | null {
  const prefix = `[LOCAL DEV] Mail login URL for ${mail}: `
  for (const line of content.slice(offset).replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/)) {
    const at = line.indexOf(prefix)
    if (at < 0) continue
    try {
      const value = new URL(line.slice(at + prefix.length).trim()).searchParams.get('otp')
      if (value && /^[0-9a-f-]{36}$/i.test(value)) return value
    } catch { continue }
  }
  return null
}

export function scheduledSlot(now: number, offsetSlots = 0): { epoch: number; local: string } {
  let epoch = Math.ceil((now + 60_000) / 300_000) * 300_000 + offsetSlots * 300_000
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  for (;;) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(epoch)).map((part) => [part.type, part.value]))
    const local = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`
    if (parseZurichDateTime(local) === epoch) return { epoch, local }
    epoch += 300_000
  }
}
