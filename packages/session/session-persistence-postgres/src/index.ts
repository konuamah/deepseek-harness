/**
 * Postgres durable session-persistence backend. One shared chat database holds
 * every Session header and its contiguous event rows; the provider owns its
 * schema, its writers' leased rows, and the staff ownership column. Startup
 * migrates and hydrates before anything serves, and an infrastructure failure
 * latches the provider unavailable instead of falling back to files.
 * @module @deepseek-ai/dsh-session-persistence-postgres
 */

import { Context, type Fiber } from '@deepseek-ai/cordis'
import { PostgresAvailability } from './availability.ts'
import { ConfigSchema, resolveSettings } from './config.ts'
import { PostgresDatabase } from './database.ts'
import { migrate } from './migrations.ts'
import { deleteExpiredSessions } from './retention.ts'
import { SessionOwnership, type PostgresOwnershipService } from './ownership.ts'
import { PostgresSessionPersistence } from './service.ts'
import { PostgresBackendTracker } from './tracker.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Database-backed staff ownership, provided by the Postgres persistence plugin. */
    sessionOwnership: PostgresOwnershipService
  }
}

export type { PostgresOwnershipService } from './ownership.ts'
export type { PendingSession } from './tracker.ts'
export { PostgresUnavailableError } from './availability.ts'

/** Plugin config for the shared Postgres chat database. */
export interface Config {
  /**
   * Postgres connection string for the dedicated chat database login. Supply
   * it from the deployment environment; it is never logged or written to a
   * Session.
   */
  connectionString: string
  /** Largest pooled connection count. Defaults to 10. */
  maxConnections?: number
  /** Bound on opening one connection. Defaults to 5 000 ms. */
  connectionTimeoutMs?: number
  /** Bound on one query and each acquired client's statement timeout. Defaults to 10 000 ms. */
  queryTimeoutMs?: number
  /** Writer lease lifetime from database time. Defaults to 30 000 ms. */
  leaseMs?: number
  /** Writer lease renewal interval; must be shorter than `leaseMs`. Defaults to 10 000 ms. */
  renewIntervalMs?: number
  /** Interval of the independent health query. Defaults to 15 000 ms. */
  healthIntervalMs?: number
  /** Bound on waiting for another instance's startup migration. Defaults to 10 000 ms. */
  migrationLockTimeoutMs?: number
  /** `application_name` reported to Postgres. Defaults to `dsh-harness`. */
  applicationName?: string
  /** Delete chats whose last activity is older than this many days. Defaults to 90. */
  retentionDays?: number
  /** Interval between retention sweeps. Defaults to one hour. */
  retentionIntervalMs?: number
  /** Largest number of Sessions one sweep deletes. Defaults to 1000. */
  retentionBatchSize?: number
}

/** Config with defaults applied and bounds checked. */
export interface Settings {
  readonly connectionString: string
  readonly maxConnections: number
  readonly connectionTimeoutMs: number
  readonly queryTimeoutMs: number
  readonly leaseMs: number
  readonly renewIntervalMs: number
  readonly healthIntervalMs: number
  readonly migrationLockTimeoutMs: number
  readonly applicationName: string
  readonly retentionDays: number
  readonly retentionIntervalMs: number
  readonly retentionBatchSize: number
}

/** Postgres persistence plugin label. */
export const name = 'session-persistence-postgres'

/** Loader schema for the shared chat database. */
export const Config = ConfigSchema

/** Delete one expired-chat batch before staff admission starts. */
async function runStartupRetention(
  ctx: Context,
  database: PostgresDatabase,
  ownership: SessionOwnership,
  settings: Settings,
): Promise<void> {
  const expired = await deleteExpiredSessions(database, ownership, {
    retentionDays: settings.retentionDays,
    batchSize: settings.retentionBatchSize,
  })
  if (expired > 0) ctx.logger.info(`session-persistence-postgres: deleted ${expired} expired chat Session(s)`)
}

/** Install the periodic retention sweep; the failure latch also stops it. */
function installRetention(
  ctx: Context,
  database: PostgresDatabase,
  ownership: SessionOwnership,
  availability: PostgresAvailability,
  settings: Settings,
): void {
  ctx.effect(function* () {
    const timer = setInterval(() => {
      deleteExpiredSessions(database, ownership, {
        retentionDays: settings.retentionDays,
        batchSize: settings.retentionBatchSize,
      }).then((deleted) => {
        if (deleted > 0) ctx.logger.info(`session-persistence-postgres: deleted ${deleted} expired chat Session(s)`)
      }, (error: unknown) => {
        // An infrastructure failure latches the provider; a permission or
        // other ordinary failure retries on the next sweep.
        if (availability.ready()) {
          ctx.logger.warn(`session-persistence-postgres: retention sweep failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      })
    }, settings.retentionIntervalMs)
    timer.unref()
    yield () => clearInterval(timer)
    yield availability.onUnavailable(() => clearInterval(timer))
  }, 'session-persistence-postgres retention')
}

/**
 * Mount Postgres persistence. Migrations run and ownership hydrates before the
 * service is provided; a startup failure rejects plugin load, and a later
 * infrastructure failure latches every operation and the staff admission view.
 * @param ctx - the owning plugin context.
 * @param config - the database connection and timeout settings.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const settings = resolveSettings(config)
  const availability = new PostgresAvailability()
  const database = new PostgresDatabase({
    connectionString: settings.connectionString,
    maxConnections: settings.maxConnections,
    connectionTimeoutMs: settings.connectionTimeoutMs,
    queryTimeoutMs: settings.queryTimeoutMs,
    applicationName: settings.applicationName,
  }, availability)
  const ownership = new SessionOwnership(database, availability)
  try {
    await migrate(database, settings.migrationLockTimeoutMs)
    await ownership.hydrate()
    await runStartupRetention(ctx, database, ownership, settings)
  } catch (error: unknown) {
    availability.fail(error)
    try {
      await database.end()
    } catch {
      // The startup failure is the reported one; a pool close failure is secondary.
    }
    throw error
  }
  availability.markReady()
  ctx.provide('sessionOwnership', ownership)
  let service!: Fiber
  ctx.effect(function* () {
    yield async () => { await database.end() }
    yield ctx.effect(function* () {
      yield availability.onUnavailable(() => {
        ctx.logger.error(
          `session-persistence-postgres: ${availability.failureReason() ?? 'database failure'}. `
          + 'The provider stays unavailable until the Harness restarts; writes in flight may have an unknown outcome.',
        )
      })
    }, 'session-persistence-postgres failure log')
    yield ctx.effect(function* () {
      const timer = setInterval(() => {
        database.query('SELECT 1').catch(() => {
          // query() latches an infrastructure failure; a refusal after the latch needs no retry.
        })
      }, settings.healthIntervalMs)
      timer.unref()
      yield () => clearInterval(timer)
      yield availability.onUnavailable(() => clearInterval(timer))
    }, 'session-persistence-postgres health monitor')
    installRetention(ctx, database, ownership, availability, settings)
    const tracker = new PostgresBackendTracker(name)
    yield tracker.install(ctx)
    service = ctx.plugin({
      name: 'session-persistence-postgres-service',
      apply(serviceCtx: Context) {
        new PostgresSessionPersistence(serviceCtx, database, tracker, ownership, settings)
      },
    })
    yield service.dispose
  }, 'session-persistence-postgres resources')
  await service.await()
}
