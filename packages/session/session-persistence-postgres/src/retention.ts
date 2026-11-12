/**
 * Retention for the shared chat database: delete whole Sessions whose last
 * activity is older than the configured window, together with their event
 * rows (by cascade) and their ownership entries. A live writer lease excludes
 * its Session from a sweep.
 * @module @deepseek-ai/dsh-session-persistence-postgres/retention
 */

import { SessionId } from '@deepseek-ai/dsh-session'
import type { PostgresDatabase } from './database.ts'
import type { SessionOwnership } from './ownership.ts'

/** Validated retention settings. */
export interface RetentionOptions {
  /** Oldest allowed age of a Session's last activity. */
  readonly retentionDays: number
  /** Largest number of Sessions one sweep deletes. */
  readonly batchSize: number
}

/**
 * Delete one bounded batch of expired Sessions and forget their owners.
 * @param database - the provider pool.
 * @param ownership - the synchronous ownership view to update after commit.
 * @param options - retention window and batch bound.
 * @returns the number of deleted Sessions.
 */
export async function deleteExpiredSessions(
  database: PostgresDatabase,
  ownership: SessionOwnership,
  options: RetentionOptions,
): Promise<number> {
  const rows = await database.query<{ id: string }>(
    `DELETE FROM dsh_sessions
     WHERE id IN (
       SELECT id FROM dsh_sessions
       WHERE updated_at < now() - ($1::integer * interval '1 day')
         AND (writer_id IS NULL OR writer_expires_at < now())
       ORDER BY updated_at
       LIMIT $2
     )
     RETURNING id`,
    [options.retentionDays, options.batchSize],
  )
  ownership.forget(rows.map(row => SessionId(row.id)))
  return rows.length
}
