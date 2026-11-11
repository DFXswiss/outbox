import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from './db'
import { writeAudit } from './audit'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('decision comment migration', () => {
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
  it('adds decisionComment to an old entries table and tolerates opening the file again', () => {
    const dir = mkdtempSync(join(tmpdir(), 'legacy-schema-'))
    tempDirs.push(dir)
    const file = join(dir, 'state.sqlite')
    const oldDb = new Database(file)
    oldDb.exec(`CREATE TABLE entries (
      id TEXT PRIMARY KEY,
      bundleId TEXT NOT NULL,
      state TEXT NOT NULL,
      text TEXT NOT NULL,
      scheduledAt INTEGER NOT NULL,
      imageSha256 TEXT,
      contentHash TEXT NOT NULL,
      checks TEXT,
      decidedByUser TEXT,
      decidedByAccount TEXT,
      decidedAt INTEGER
    )`)
    oldDb.close()

    const migrated = openDatabase(file)
    const columns = migrated.pragma('table_info(entries)') as Array<{ name: string }>
    expect(columns.map((column) => column.name)).toContain('decisionComment')
    migrated.close()

    const reopened = openDatabase(file)
    const reopenedColumns = reopened.pragma('table_info(entries)') as Array<{ name: string }>
    expect(reopenedColumns.filter((column) => column.name === 'decisionComment')).toHaveLength(1)
    reopened.close()
  })
})

describe('audit actor migration', () => {
  it('adds actorKind to an old audit table and tolerates opening the file again', () => {
    const dir = mkdtempSync(join(tmpdir(), 'legacy-audit-'))
    tempDirs.push(dir)
    const file = join(dir, 'state.sqlite')
    const oldDb = new Database(file)
    oldDb.exec(`CREATE TABLE audit (
      id TEXT PRIMARY KEY,
      at INTEGER NOT NULL,
      event TEXT NOT NULL,
      bundleId TEXT,
      entryId TEXT,
      actorUser INTEGER,
      actorAccount INTEGER,
      reason TEXT
    )`)
    oldDb.close()

    const migrated = openDatabase(file)
    const event = { at: 1, event: 'published' as const, bundleId: null, entryId: null, reason: null }
    writeAudit(migrated, { ...event, actorUser: null, actorAccount: null })
    expect(migrated.prepare('SELECT actorKind, actorUser, actorAccount FROM audit').get()).toEqual({ actorKind: 'system', actorUser: null, actorAccount: null })
    migrated.close()

    const reopened = openDatabase(file)
    writeAudit(reopened, { ...event, at: 2, actorUser: 17, actorAccount: 23 })
    expect(reopened.prepare('SELECT actorKind, actorUser, actorAccount FROM audit ORDER BY at').all()).toEqual([
      { actorKind: 'system', actorUser: null, actorAccount: null },
      { actorKind: 'user', actorUser: 17, actorAccount: 23 }
    ])
    reopened.close()
  })
})
