import Database from 'better-sqlite3'

/** Milliseconds. better-sqlite3 also accepts this via the `timeout` constructor option. */
const BUSY_TIMEOUT_MS = 5_000

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bundles (
  id TEXT PRIMARY KEY,
  createdAt INTEGER NOT NULL,
  authoredByUser INTEGER NOT NULL,
  authoredByAccount INTEGER NOT NULL
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
  decidedByUser INTEGER,
  decidedByAccount INTEGER,
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
  authoredByUser INTEGER NOT NULL,
  authoredByAccount INTEGER NOT NULL,
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
  actorKind TEXT NOT NULL CHECK (actorKind IN ('user', 'system')),
  actorUser INTEGER,
  actorAccount INTEGER,
  reason TEXT,
  CHECK ((actorKind = 'system' AND actorUser IS NULL AND actorAccount IS NULL) OR
         (actorKind = 'user' AND actorUser IS NOT NULL AND actorAccount IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS auth_pending (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  createdAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS media (
  sha256 TEXT PRIMARY KEY,
  mime TEXT NOT NULL,
  bytes BLOB NOT NULL,
  createdAt INTEGER NOT NULL
);
`

const SCHEMA_VERSION = 1

const OUTBOX_TABLES = [
  'bundles',
  'entries',
  'scheduled_posts',
  'publish_results',
  'x_credentials',
  'audit',
  'auth_pending',
  'media'
] as const

type SqliteHandle = InstanceType<typeof Database>

function readUserVersion(db: SqliteHandle): number {
  const value = db.pragma('user_version', { simple: true })
  return typeof value === 'number' && Number.isInteger(value) ? value : Number.NaN
}

function hasOutboxTable(db: SqliteHandle): boolean {
  const placeholders = OUTBOX_TABLES.map(() => '?').join(', ')
  const row = db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders}) LIMIT 1`
  ).get(...OUTBOX_TABLES)
  return row !== undefined
}

/**
 * Opens or creates a SQLite file at `filePath`. The path is required; this
 * module does not pick a location. A file that already has Outbox tables from
 * a different schema version is closed and rejected without being changed.
 */
export function openDatabase(filePath: string) {
  const db = new Database(filePath, { timeout: BUSY_TIMEOUT_MS })
  const version = readUserVersion(db)
  if (hasOutboxTable(db) && version !== SCHEMA_VERSION) {
    db.close()
    throw new Error(
      `This database was created by an unreleased version of Outbox (schema version ${version}). Start with a new database file.`
    )
  }
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`)
  if (version !== SCHEMA_VERSION) {
    const install = db.transaction(() => {
      db.exec(SCHEMA)
      db.pragma(`user_version = ${SCHEMA_VERSION}`)
    })
    try {
      install.immediate()
    } catch (error) {
      db.close()
      throw error
    }
  } else {
    db.exec(SCHEMA)
  }
  return db
}

export type SqliteDatabase = ReturnType<typeof openDatabase>
