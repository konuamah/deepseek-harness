/**
 * Loader configuration for the shared Postgres chat database and its validated
 * cross-field bounds.
 * @module @deepseek-ai/dsh-session-persistence-postgres/config
 */

import z from '@deepseek-ai/schemastery'
import type { Config, Settings } from './index.ts'

const DEFAULT_MAX_CONNECTIONS = 10
const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000
const DEFAULT_QUERY_TIMEOUT_MS = 10_000
const DEFAULT_LEASE_MS = 30_000
const DEFAULT_RENEW_INTERVAL_MS = 10_000
const DEFAULT_HEALTH_INTERVAL_MS = 15_000
const DEFAULT_MIGRATION_LOCK_TIMEOUT_MS = 10_000
const DEFAULT_APPLICATION_NAME = 'dsh-harness'
const DEFAULT_RETENTION_DAYS = 90
const DEFAULT_RETENTION_INTERVAL_MS = 3_600_000
const DEFAULT_RETENTION_BATCH_SIZE = 1_000

/** Loader schema for the shared chat database. */
export const ConfigSchema: z<Config> = z.object({
  connectionString: z.string().required(),
  maxConnections: z.natural().min(1).default(DEFAULT_MAX_CONNECTIONS),
  connectionTimeoutMs: z.natural().min(1).default(DEFAULT_CONNECTION_TIMEOUT_MS),
  queryTimeoutMs: z.natural().min(1).default(DEFAULT_QUERY_TIMEOUT_MS),
  leaseMs: z.natural().min(1).default(DEFAULT_LEASE_MS),
  renewIntervalMs: z.natural().min(1).default(DEFAULT_RENEW_INTERVAL_MS),
  healthIntervalMs: z.natural().min(1).default(DEFAULT_HEALTH_INTERVAL_MS),
  migrationLockTimeoutMs: z.natural().min(1).default(DEFAULT_MIGRATION_LOCK_TIMEOUT_MS),
  applicationName: z.string().default(DEFAULT_APPLICATION_NAME),
  retentionDays: z.natural().min(1).default(DEFAULT_RETENTION_DAYS),
  retentionIntervalMs: z.natural().min(1).default(DEFAULT_RETENTION_INTERVAL_MS),
  retentionBatchSize: z.natural().min(1).default(DEFAULT_RETENTION_BATCH_SIZE),
})

/** Apply one optional setting's default without repeating `??` at every field. */
function withDefault<Value>(value: Value | undefined, fallback: Value): Value {
  return value ?? fallback
}

/** @throws Error naming the first non-positive delay field. */
function assertPositiveDelays(settings: Settings): void {
  const delays: readonly (readonly [string, number])[] = [
    ['maxConnections', settings.maxConnections],
    ['connectionTimeoutMs', settings.connectionTimeoutMs],
    ['queryTimeoutMs', settings.queryTimeoutMs],
    ['leaseMs', settings.leaseMs],
    ['renewIntervalMs', settings.renewIntervalMs],
    ['healthIntervalMs', settings.healthIntervalMs],
    ['migrationLockTimeoutMs', settings.migrationLockTimeoutMs],
    ['retentionDays', settings.retentionDays],
    ['retentionIntervalMs', settings.retentionIntervalMs],
    ['retentionBatchSize', settings.retentionBatchSize],
  ]
  for (const [field, value] of delays) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`session-persistence-postgres: ${field} must be a positive whole number`)
    }
  }
}

/**
 * Apply defaults and validate the cross-field bounds.
 * @param config - plugin configuration as written.
 * @returns the settings the provider runs with.
 * @throws Error naming the first invalid setting; connection secrets are never echoed.
 */
export function resolveSettings(config: Config): Settings {
  const connectionString = config.connectionString
  if (typeof connectionString !== 'string' || connectionString.trim() === '') {
    throw new Error('session-persistence-postgres: connectionString is required')
  }
  const applicationName = config.applicationName ?? DEFAULT_APPLICATION_NAME
  if (typeof applicationName !== 'string' || applicationName === '') {
    throw new Error('session-persistence-postgres: applicationName must be a non-empty string')
  }
  const settings: Settings = {
    connectionString,
    maxConnections: withDefault(config.maxConnections, DEFAULT_MAX_CONNECTIONS),
    connectionTimeoutMs: withDefault(config.connectionTimeoutMs, DEFAULT_CONNECTION_TIMEOUT_MS),
    queryTimeoutMs: withDefault(config.queryTimeoutMs, DEFAULT_QUERY_TIMEOUT_MS),
    leaseMs: withDefault(config.leaseMs, DEFAULT_LEASE_MS),
    renewIntervalMs: withDefault(config.renewIntervalMs, DEFAULT_RENEW_INTERVAL_MS),
    healthIntervalMs: withDefault(config.healthIntervalMs, DEFAULT_HEALTH_INTERVAL_MS),
    migrationLockTimeoutMs: withDefault(config.migrationLockTimeoutMs, DEFAULT_MIGRATION_LOCK_TIMEOUT_MS),
    applicationName: withDefault(config.applicationName, DEFAULT_APPLICATION_NAME),
    retentionDays: withDefault(config.retentionDays, DEFAULT_RETENTION_DAYS),
    retentionIntervalMs: withDefault(config.retentionIntervalMs, DEFAULT_RETENTION_INTERVAL_MS),
    retentionBatchSize: withDefault(config.retentionBatchSize, DEFAULT_RETENTION_BATCH_SIZE),
  }
  assertPositiveDelays(settings)
  if (settings.renewIntervalMs >= settings.leaseMs) {
    throw new Error('session-persistence-postgres: renewIntervalMs must be shorter than leaseMs')
  }
  return settings
}
