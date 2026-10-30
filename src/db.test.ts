import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from './db'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('decision comment migration', () => {
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
