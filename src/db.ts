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
  decidedAt INTEGER,
  decisionComment TEXT
);

CREATE TABLE IF NOT EXISTS scheduled_posts (
  id TEXT PRIMARY KEY,
  entryId TEXT NOT NULL REFERENCES entries(id),
  channel TEXT NOT NULL,
  status TEXT NOT NULL,
  url TEXT,
  startedAt INTEGER,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  authoredByUser TEXT NOT NULL,
  authoredByAccount TEXT NOT NULL,
  UNIQUE (entryId, channel)
);

CREATE TABLE IF NOT EXISTS publish_results (
  id TEXT PRIMARY KEY,
  scheduledPostId TEXT NOT NULL REFERENCES scheduled_posts(id),
  at INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  url TEXT,
  error TEXT,
  uncertain INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS x_credentials (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  accessToken TEXT,
  accessTokenExpiresAt INTEGER,
  refreshToken TEXT NOT NULL,
  seedHash TEXT NOT NULL,
  updatedAt INTEGER NOT NULL
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

CREATE TABLE IF NOT EXISTS media (
  sha256 TEXT PRIMARY KEY,
  mime TEXT NOT NULL,
  bytes BLOB NOT NULL,
  createdAt INTEGER NOT NULL
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
  const entryColumns = db.pragma('table_info(entries)') as Array<{ name: string }>
  if (!entryColumns.some((column) => column.name === 'decisionComment')) {
    db.exec('ALTER TABLE entries ADD COLUMN decisionComment TEXT')
  }
  return db
}

export type SqliteDatabase = ReturnType<typeof openDatabase>
