/**
 * Own-table schema migrations for the shared chat database. Migrations run in
 * one transaction behind a transaction-scoped advisory lock, so concurrent
 * starts serialize, a failed migration rolls back whole, and a schema newer
 * than this build refuses startup instead of writing into it.
 * @module @deepseek-ai/dsh-session-persistence-postgres/migrations
 */

import type { PoolClient } from 'pg'
import type { PostgresDatabase } from './database.ts'

/** Schema generation this build writes and reads. */
export const SCHEMA_VERSION = 1

/** Advisory-lock key shared by every harness instance (`classid`, `objid`). */
const MIGRATION_LOCK_KEY: readonly [number, number] = [1_684_301_171, 1]

/** One forward migration; statements are idempotent only through its version record. */
interface Migration {
  readonly version: number
  readonly statements: readonly string[]
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE dsh_sessions (
        id text PRIMARY KEY,
        owner_id bigint CHECK (owner_id IS NULL OR owner_id > 0),
        header text NOT NULL,
        inherited_event_count integer NOT NULL CHECK (inherited_event_count >= 0),
        event_count integer NOT NULL CHECK (event_count >= 0),
        revision bigint NOT NULL,
        materialized boolean NOT NULL DEFAULT false,
        writer_id text,
        writer_expires_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CHECK ((writer_id IS NULL) = (writer_expires_at IS NULL))
      )`,
      `CREATE INDEX dsh_sessions_owner_idx ON dsh_sessions (owner_id) WHERE owner_id IS NOT NULL`,
      `CREATE TABLE dsh_session_events (
        session_id text NOT NULL REFERENCES dsh_sessions(id) ON DELETE CASCADE,
        seq integer NOT NULL CHECK (seq >= 0),
        payload text NOT NULL,
        PRIMARY KEY (session_id, seq)
      )`,
    ],
  },
]

/** Run every migration this build has but the database lacks. */
async function apply(client: PoolClient, current: number): Promise<void> {
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue
    for (const statement of migration.statements) await client.query(statement)
    await client.query('INSERT INTO dsh_schema_migrations (version) VALUES ($1)', [migration.version])
  }
}

/** Read the newest recorded generation; an empty table is version 0. */
async function recordedVersion(client: PoolClient): Promise<number> {
  const { rows } = await client.query<{ version: number }>('SELECT version FROM dsh_schema_migrations ORDER BY version DESC LIMIT 1')
  const newest = rows[0]
  return newest === undefined ? 0 : newest.version
}

/**
 * Serialize startup migrations and apply them transactionally.
 * @param database - the pool the migrations run through.
 * @param migrationLockTimeoutMs - bound on waiting for another instance's migration.
 * @throws Error when the recorded schema is newer than this build, or any migration fails.
 */
export async function migrate(database: PostgresDatabase, migrationLockTimeoutMs: number): Promise<void> {
  await database.withTransaction(async (client) => {
    await client.query(`SET LOCAL lock_timeout = ${Math.trunc(migrationLockTimeoutMs)}`)
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [...MIGRATION_LOCK_KEY])
    await client.query(`CREATE TABLE IF NOT EXISTS dsh_schema_migrations (
      version integer PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`)
    const current = await recordedVersion(client)
    if (current > SCHEMA_VERSION) {
      throw new Error(
        `chat database schema version ${current} is newer than this Harness supports (${SCHEMA_VERSION}); upgrade the Harness`,
      )
    }
    await apply(client, current)
  })
}
