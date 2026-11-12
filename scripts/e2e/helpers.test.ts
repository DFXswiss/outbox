import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { duplicateContentFailure, findMailOtp, saveRefreshToken, scheduledSlot, totp, unexpectedPostStatus } from './helpers'
import { parseZurichDateTime } from '../../src/time'
import { openDatabase } from '../../src/db'

describe('E2E helpers', () => {
  it('reports the newest stored error for the post and redacts known secrets', () => {
    const db = openDatabase(':memory:')
    try {
      db.pragma('foreign_keys = OFF')
      const insert = db.prepare('INSERT INTO publish_results (id, scheduledPostId, at, ok, url, error, uncertain) VALUES (?, ?, ?, 0, NULL, ?, 0)')
      insert.run('old', 'post-1', 10, 'Old error')
      insert.run('same-time-earlier', 'post-1', 20, 'Earlier error at the same time')
      // Captured X response, real E2E run, 2026-11-10: HTTP 402 Payment Required, credits depleted; the credential suffix is a test fixture.
      insert.run('new', 'post-1', 20, 'HTTP 402: Payment Required: credits depleted; credential test-secret-long')
      insert.run('other', 'post-2', 30, 'Other post error')
      expect(unexpectedPostStatus(db, 'post-1', 'failed', ['test-secret', 'test-secret-long']))
        .toBe('X publish failed: HTTP 402: Payment Required: credits depleted; credential [redacted]')
      expect(unexpectedPostStatus(db, 'post-2', 'uncertain', [])).toBe('X publish uncertain: Other post error')
      expect(unexpectedPostStatus(db, 'missing', 'failed', [])).toBe('X publish failed: No stored error detail')
      // Captured from the real X API, stored by Outbox in a real end-to-end run on 2026-11-12
      insert.run('dup', 'post-dup', 40, 'HTTP 403: Forbidden: You are not allowed to create a Tweet with duplicate content.')
      // Constructed: HTTP 403 whose detail only contains the words "duplicate content", not the captured sentence.
      insert.run('partial', 'post-partial', 45, 'HTTP 403: Forbidden: request flagged as duplicate content spam by policy')
      // Constructed: the captured sentence, but status HTTP 400 instead of HTTP 403.
      insert.run('other-status', 'post-status', 48, 'HTTP 400: Bad Request: You are not allowed to create a Tweet with duplicate content.')
      insert.run('older-dup', 'post-mixed', 50, 'HTTP 403: Forbidden: You are not allowed to create a Tweet with duplicate content.')
      insert.run('newer-other', 'post-mixed', 60, 'HTTP 403: Forbidden')
      insert.run('secret', 'post-secret', 70, 'HTTP 402: credential test-secret-long')
      expect(duplicateContentFailure(db, 'post-dup', [])).toBeNull()
      expect(duplicateContentFailure(db, 'post-partial', [])).toBe('X publish failed: HTTP 403: Forbidden: request flagged as duplicate content spam by policy')
      expect(duplicateContentFailure(db, 'post-status', [])).toBe('X publish failed: HTTP 400: Bad Request: You are not allowed to create a Tweet with duplicate content.')
      expect(duplicateContentFailure(db, 'post-mixed', [])).toBe('X publish failed: HTTP 403: Forbidden')
      expect(duplicateContentFailure(db, 'post-secret', ['test-secret-long'])).toBe('X publish failed: HTTP 402: credential [redacted]')
      expect(duplicateContentFailure(db, 'missing', [])).toBe('X publish failed: No stored error detail')
    } finally { db.close() }
  })
  it.each([[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']])('matches RFC 6238 SHA-1 at %s', (seconds, expected) => {
    expect(totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', seconds * 1000, 8)).toBe(expected)
  })

  it('replaces the refresh token once and retains mode 600', () => {
    const dir = mkdtempSync(join(tmpdir(), 'outbox-e2e-env-'))
    try {
      const path = join(dir, 'x.env')
      writeFileSync(path, 'X_HANDLE=test\nX_REFRESH_TOKEN=old\n', { mode: 0o600 })
      const stdout = vi.spyOn(process.stdout, 'write')
      try {
        saveRefreshToken(path, 'new')
        expect(stdout).not.toHaveBeenCalled()
      } finally { stdout.mockRestore() }
      expect(readFileSync(path, 'utf8')).toBe('X_HANDLE=test\nX_REFRESH_TOKEN=new\n')
      expect(statSync(path).mode & 0o777).toBe(0o600)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it.each([Date.UTC(2026, 2, 29, 0, 59), Date.UTC(2026, 9, 25, 0, 59), Date.UTC(2026, 0, 1, 11, 57)])('selects a Zurich slot with at least a minute lead at %s', (now) => {
    const slot = scheduledSlot(now)
    expect(slot.epoch - now).toBeGreaterThanOrEqual(60_000)
    expect(slot.epoch % 300_000).toBe(0)
    expect(parseZurichDateTime(slot.local)).toBe(slot.epoch)
  })

  it('finds the requested OTP in colored backend logs after the given offset', () => {
    // Captured from the log of a locally running DFX API (ENVIRONMENT=loc) on 2026-11-09
    const line = '\x1b[32m[Nest] 63657  - \x1b[39m09.11.2026, 13:25:04 \x1b[32m    LOG\x1b[39m \x1b[38;5;3m[AuthService] \x1b[39m\x1b[32m[LOCAL DEV] Mail login URL for outbox-e2e-a82cb24a5355e49c@example.invalid: http://localhost:3000/mail-login?otp=3f0c2a3e-8a7b-4c1d-9e2f-1a2b3c4d5e6f\x1b[39m\n'
    const mail = 'outbox-e2e-a82cb24a5355e49c@example.invalid'
    const otherLine = line.replace(mail, 'different@example.invalid').replace('3f0c2a3e-8a7b-4c1d-9e2f-1a2b3c4d5e6f', '12345678-1234-1234-1234-123456789abc')
    expect(findMailOtp(line, line.length, mail)).toBeNull()
    expect(findMailOtp(line, 0, 'different@example.invalid')).toBeNull()
    expect(findMailOtp(line, 0, mail)).toBe('3f0c2a3e-8a7b-4c1d-9e2f-1a2b3c4d5e6f')
    expect(findMailOtp(otherLine + line, 0, mail)).toBe('3f0c2a3e-8a7b-4c1d-9e2f-1a2b3c4d5e6f')
    expect(findMailOtp(otherLine + line, otherLine.length, 'different@example.invalid')).toBeNull()
    const broken = `[LOCAL DEV] Mail login URL for ${mail}: not a url\n`
    const valid = `[LOCAL DEV] Mail login URL for ${mail}: http://localhost:3000/mail-login?otp=3f0c2a3e-8a7b-4c1d-9e2f-1a2b3c4d5e6f\n`
    expect(findMailOtp(broken + valid, 0, mail)).toBe('3f0c2a3e-8a7b-4c1d-9e2f-1a2b3c4d5e6f')
  })
})
