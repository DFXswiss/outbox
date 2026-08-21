import { randomUUID } from 'node:crypto'
import type { SqliteDatabase } from './db'

export const AUDIT_EVENTS = ['submitted', 'retracted', 'decided', 'refused'] as const
export type AuditEvent = (typeof AUDIT_EVENTS)[number]

export type AuditRecord = {
  at: number
  event: AuditEvent
  bundleId: string | null
  entryId: string | null
  actorUser: string
  actorAccount: string
  reason: string | null
}

/** Identity is JWT user/account, passed in — never a typed address. */
export function writeAudit(db: SqliteDatabase, record: AuditRecord): void {
  db.prepare(
    `INSERT INTO audit (id, at, event, bundleId, entryId, actorUser, actorAccount, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    randomUUID(),
    record.at,
    record.event,
    record.bundleId,
    record.entryId,
    record.actorUser,
    record.actorAccount,
    record.reason
  )
}
