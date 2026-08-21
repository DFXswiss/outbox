import Database from 'better-sqlite3'

/** Milliseconds. better-sqlite3 also accepts this via the `timeout` constructor option. */
const BUSY_TIMEOUT_MS = 5_000

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bundles (
  id TEXT PRIMARY KEY,
  createdAt INTEGER NOT NULL,
  authoredByUser TEXT NOT NULL,
  authoredByAccount TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,
  bundleId TEXT NOT NULL REFERENCES bundles(id),
  state TEXT NOT NULL,
  text TEXT NOT NULL,
  scheduledAt INTEGER NOT NULL,
  imageSha256 TEXT,
  contentHash TEXT NOT NULL,
  checks TEXT,
  decidedByUser TEXT,
  decidedByAccount TEXT,
  decidedAt INTEGER
);

CREATE TABLE IF NOT EXISTS scheduled_posts (
  id TEXT PRIMARY KEY,
  entryId TEXT NOT NULL REFERENCES entries(id),
  channel TEXT NOT NULL,
  status TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  UNIQUE (entryId, channel)
);

CREATE TABLE IF NOT EXISTS audit (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  event TEXT NOT NULL,
  bundleId TEXT,
  entryId TEXT,
  actorUser TEXT NOT NULL,
  actorAccount TEXT NOT NULL,
  reason TEXT
);
`

/**
 * Opens (or creates) a SQLite file at `filePath`. The path is required; this
 * module does not pick a location.
 */
export function openDatabase(filePath: string) {
  const db = new Database(filePath, { timeout: BUSY_TIMEOUT_MS })
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`)
  db.exec(SCHEMA)
  return db
}

export type SqliteDatabase = ReturnType<typeof openDatabase>
