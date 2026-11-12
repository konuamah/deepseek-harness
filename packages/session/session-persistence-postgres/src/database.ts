/**
 * The provider-owned Postgres pool: one bounded connection source with
 * validated timeouts, a query helper that latches infrastructure failure, and
 * a transaction helper that destroys a client whose outcome is unknown.
 * @module @deepseek-ai/dsh-session-persistence-postgres/database
 */

import { Pool, type PoolClient, type QueryResultRow } from 'pg'
import type { PostgresAvailability } from './availability.ts'

/** Validated pool and timeout settings. */
export interface DatabaseOptions {
  /** Postgres connection string supplied by the deployment environment. */
  readonly connectionString: string
  /** Largest number of pooled connections; defaults to 10. */
  readonly maxConnections: number
  /** Bound on establishing one connection. */
  readonly connectionTimeoutMs: number
  /** Bound on one query, from send to result. */
  readonly queryTimeoutMs: number
  /** `application_name` reported to Postgres. */
  readonly applicationName: string
}

/** Shutdown, capacity, and socket failures that no retry can fix in this process. */
const NON_RETRYABLE_CODES = new Set([
  '57P01', '57P02', '57P03', '53300', '53400',
  'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH',
])
const CONNECTION_MESSAGE = /connection terminated|connection error|timeout exceeded when trying to connect/i

/** Connection and server-outage failures that permanently end this process's service. */
function isInfrastructureFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = (error as NodeJS.ErrnoException).code
  // Class 08 is connection_exception; the set holds shutdown and availability refusals.
  return code === undefined
    ? CONNECTION_MESSAGE.test(error.message)
    : code.startsWith('08') || NON_RETRYABLE_CODES.has(code)
}

/** Whether a caught error must latch the provider unavailable. */
export function isPostgresInfrastructureFailure(error: unknown): boolean {
  return isInfrastructureFailure(error)
}

/** One configured pool plus the failure latch every operation reports to. */
export class PostgresDatabase {
  private readonly pool: Pool
  private readonly statementTimeoutMs: number

  /**
   * @param options - connection string, pool size, and timeout bounds.
   * @param availability - the lifecycle that an infrastructure failure latches.
   */
  constructor(options: DatabaseOptions, private readonly availability: PostgresAvailability) {
    this.statementTimeoutMs = options.queryTimeoutMs
    this.pool = new Pool({
      connectionString: options.connectionString,
      max: options.maxConnections,
      connectionTimeoutMillis: options.connectionTimeoutMs,
      query_timeout: options.queryTimeoutMs,
      idleTimeoutMillis: 30_000,
      application_name: options.applicationName,
    })
    this.pool.on('error', (error: Error) => { this.note(error) })
  }

  /** Latch an infrastructure failure without changing the caller's error. */
  note(error: unknown): void {
    if (isInfrastructureFailure(error)) this.availability.fail(error)
  }

  /**
   * Run one parameterized statement from the pool.
   * @param text - query text; values are always sent separately.
   * @param values - bound parameters.
   * @returns the result rows.
   */
  async query<Row extends QueryResultRow>(text: string, values?: unknown[]): Promise<Row[]> {
    this.availability.ensureReady()
    try {
      const result = await this.pool.query<Row>(text, values)
      return result.rows
    } catch (error: unknown) {
      this.note(error)
      throw error
    }
  }

  /**
   * Borrow one client with its statement timeout applied. The caller must
   * release it through {@link withClient} or {@link withTransaction}.
   * @returns the checked-out client.
   */
  async connect(): Promise<PoolClient> {
    this.availability.ensureReady()
    let client: PoolClient
    try {
      client = await this.pool.connect()
    } catch (error: unknown) {
      this.note(error)
      throw error
    }
    try {
      await client.query(`SET statement_timeout = ${Math.trunc(this.statementTimeoutMs)}`)
      return client
    } catch (error: unknown) {
      this.note(error)
      client.release(true)
      throw error
    }
  }

  /**
   * Run one operation on a borrowed client and release it. Infrastructure
   * failure destroys the client so a half-sent statement never returns to the
   * pool.
   * @param operation - the work using the client.
   * @returns the operation result.
   */
  async withClient<Value>(operation: (client: PoolClient) => Promise<Value>): Promise<Value> {
    const client = await this.connect()
    let healthy = true
    try {
      return await operation(client)
    } catch (error: unknown) {
      healthy = !isInfrastructureFailure(error)
      this.note(error)
      throw error
    } finally {
      client.release(healthy ? undefined : true)
    }
  }

  /**
   * Run one transaction. A failing `COMMIT` is an ambiguous outcome: the
   * failure is latched and no caller-level replay happens.
   * @param operation - the transactional work using the same client.
   * @returns the operation result after commit.
   */
  async withTransaction<Value>(operation: (client: PoolClient) => Promise<Value>): Promise<Value> {
    return this.withClient(async (client) => {
      await client.query('BEGIN')
      let value: Value
      try {
        value = await operation(client)
      } catch (error: unknown) {
        try {
          await client.query('ROLLBACK')
        } catch (rollbackError: unknown) {
          // A transaction that cannot roll back has an unknown server state:
          // latch, while still reporting the operation failure to its caller.
          this.availability.fail(rollbackError)
        }
        throw error
      }
      try {
        await client.query('COMMIT')
      } catch (error: unknown) {
        this.availability.fail(error)
        throw error
      }
      return value
    })
  }

  /** Close every pooled connection; idempotent. */
  async end(): Promise<void> {
    await this.pool.end()
  }
}
