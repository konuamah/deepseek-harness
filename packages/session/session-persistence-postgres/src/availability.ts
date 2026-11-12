/**
 * One latched lifecycle for the Postgres chat storage: `starting` until the
 * first migration and ownership hydration finish, `ready` while the database
 * answers, and `failed` forever after an infrastructure failure. A latched
 * failure is never cleared inside the process, so no operation silently
 * recovers from an unknown commit outcome.
 * @module @deepseek-ai/dsh-session-persistence-postgres/availability
 */

/** States the backend moves through exactly once, in order. */
export type PostgresAvailabilityState = 'starting' | 'ready' | 'failed'

/** The database cannot serve this process; restart the Harness after fixing it. */
export class PostgresUnavailableError extends Error {
  /** @param reason - sanitized failure text without connection secrets. */
  constructor(readonly reason: string) {
    super(`session-persistence-postgres: chat storage is unavailable (${reason}); restart the Harness before serving staff`)
    this.name = 'PostgresUnavailableError'
  }
}

/** Keep a failure line free of credentials and bounded in length. */
function sanitize(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause)
  const code = cause instanceof Error && 'code' in cause && typeof cause.code === 'string'
    ? cause.code
    : undefined
  const line = (text.split('\n')[0] ?? '').replace(/\/\/[^/@\s]*@/g, '//[redacted]@').slice(0, 200)
  return code === undefined ? line : `${code}: ${line}`
}

/** Latched availability shared by the provider, ownership view, and staff access. */
export class PostgresAvailability {
  private current: PostgresAvailabilityState = 'starting'
  private failure: string | undefined
  private readonly listeners = new Set<() => void>()

  /** Current lifecycle state. */
  state(): PostgresAvailabilityState {
    return this.current
  }

  /** Whether operations may proceed. */
  ready(): boolean {
    return this.current === 'ready'
  }

  /**
   * Refuse work only after a latched failure. Startup migrations and ownership
   * hydration run while the state is still `starting`; staff admission reads
   * {@link ready} and stays closed until those finish.
   * @throws {PostgresUnavailableError} once the backend has failed.
   */
  ensureReady(): void {
    if (this.current === 'failed') throw new PostgresUnavailableError(this.failure ?? 'the backend failed')
  }

  /** Leave the startup phase; a failure already latched during startup is kept. */
  markReady(): void {
    if (this.current === 'starting') this.current = 'ready'
  }

  /** The sanitized first failure, or undefined while starting or ready. */
  failureReason(): string | undefined {
    return this.failure
  }

  /**
   * Latch a persistent availability failure. The first cause is kept and every
   * listener runs once; later calls change nothing.
   * @param cause - the infrastructure failure to record.
   */
  fail(cause: unknown): void {
    if (this.current === 'failed') return
    this.current = 'failed'
    this.failure = sanitize(cause)
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        // A cleanup listener must not hide the failure that triggered it.
      }
    }
  }

  /**
   * Observe the first latched failure.
   * @param listener - runs once when the backend fails.
   * @returns a disposer removing a listener that has not run yet.
   */
  onUnavailable(listener: () => void): () => void {
    if (this.current === 'failed') {
      listener()
      return () => {}
    }
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}
