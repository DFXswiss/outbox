import { createHmac } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseZurichDateTime } from '../../src/time'
import type { SqliteDatabase } from '../../src/db'
import { parseEnv } from '../env-file'
export { parseEnv, saveRefreshToken } from '../env-file'

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
  const error = row?.error ?? ''
  if (error.startsWith('HTTP 403: ') && error.includes('You are not allowed to create a Tweet with duplicate content.')) return null
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

export function readPrivateEnv(path: string): Record<string, string> {
  if ((statSync(path).mode & 0o777) !== 0o600) throw new Error('X environment file must have mode 600')
  return parseEnv(readFileSync(path, 'utf8'))
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

export function preserveDatabaseFiles(dbPath: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'outbox-e2e-keep-'))
  chmodSync(directory, 0o700)
  for (const suffix of ['', '-wal', '-shm']) {
    const source = `${dbPath}${suffix}`
    if (!existsSync(source)) continue
    const target = join(directory, `outbox.sqlite${suffix}`)
    copyFileSync(source, target)
    chmodSync(target, 0o600)
  }
  return directory
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
