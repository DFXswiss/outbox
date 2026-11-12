import Database from 'better-sqlite3'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from './db'
import { writeAudit } from './audit'

const LEGACY_AUDIT = `CREATE TABLE audit (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  event TEXT NOT NULL,
  bundleId TEXT,
  entryId TEXT,
  actorUser TEXT NOT NULL,
  actorAccount TEXT NOT NULL,
  reason TEXT
)`

function writeLegacyAudit(file: string, userVersion: number): void {
  const oldDb = new Database(file)
  oldDb.exec(LEGACY_AUDIT)
  oldDb.prepare(
    `INSERT INTO audit (id, at, event, actorUser, actorAccount) VALUES (?, ?, ?, ?, ?)`
  ).run('legacy-system', 1, 'published', 'system', 'system')
  if (userVersion !== 0) oldDb.pragma(`user_version = ${userVersion}`)
  oldDb.close()
}

function legacySnapshot(file: string): { bytes: Buffer; sql: unknown; row: unknown; version: unknown } {
  const bytes = readFileSync(file)
  const db = new Database(file, { readonly: true, fileMustExist: true })
  try {
    return {
      bytes,
      sql: db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'audit'`).get(),
      row: db.prepare('SELECT actorUser, actorAccount FROM audit').get(),
      version: db.pragma('user_version', { simple: true })
    }
  } finally {
    db.close()
  }
}

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('schema version', () => {
  it('stores numeric user identities separately from system audit events', () => {
    const db = openDatabase(':memory:')
    const event = { at: 1, event: 'published' as const, bundleId: null, entryId: null, reason: null }
    writeAudit(db, { ...event, actorUser: null, actorAccount: null })
    writeAudit(db, { ...event, actorUser: 17, actorAccount: 23 })
    const rows = db.prepare('SELECT actorKind, actorUser, actorAccount FROM audit ORDER BY rowid').all()
    expect(rows).toEqual([{ actorKind: 'system', actorUser: null, actorAccount: null }, { actorKind: 'user', actorUser: 17, actorAccount: 23 }])
    const columns = db.pragma('table_info(bundles)') as Array<{ name: string; type: string }>
    expect(columns.find((column) => column.name === 'authoredByAccount')?.type).toBe('INTEGER')
    db.close()
  })

  it('creates a new file at schema version 1 and opens it again', () => {
    const dir = mkdtempSync(join(tmpdir(), 'outbox-schema-'))
    tempDirs.push(dir)
    const file = join(dir, 'state.sqlite')
    const created = openDatabase(file)
    expect(created.pragma('user_version', { simple: true })).toBe(1)
    created.close()
    const reopened = openDatabase(file)
    expect(reopened.pragma('user_version', { simple: true })).toBe(1)
    reopened.close()
  })

  it.each([0, 2])('rejects an unreleased Outbox file at schema version %s without changing it', (userVersion) => {
    const dir = mkdtempSync(join(tmpdir(), 'legacy-audit-'))
    tempDirs.push(dir)
    const file = join(dir, 'state.sqlite')
    writeLegacyAudit(file, userVersion)
    const before = legacySnapshot(file)
    expect(before.version).toBe(userVersion)
    const bytes = readFileSync(file)
    expect(() => openDatabase(file)).toThrow(
      `This database was created by an unreleased version of Outbox (schema version ${userVersion}). Start with a new database file.`
    )
    expect(existsSync(`${file}-wal`)).toBe(false)
    expect(existsSync(`${file}-shm`)).toBe(false)
    expect(readFileSync(file)).toEqual(bytes)
    const after = legacySnapshot(file)
    expect(after.sql).toEqual(before.sql)
    expect(after.row).toEqual({ actorUser: 'system', actorAccount: 'system' })
    expect(after.version).toBe(userVersion)
  })
})
