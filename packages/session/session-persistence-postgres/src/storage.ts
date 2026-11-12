/**
 * The Postgres provider's session handle, routed live-write buffer, and
 * teardown tracker. Each write handle owns one row-fenced writer lease; every
 * append commits its event rows and lease renewal in one transaction, so a
 * stale handle cannot write after another instance takes the lease over.
 * @module @deepseek-ai/dsh-session-persistence-postgres/storage
 */

import type { SessionEvent, SessionHeader, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import {
  SessionHandleClosedError,
  SessionOwnershipLostError,
  SessionReadOnlyError,
  type SessionAccess,
  type SessionHandle,
  type SessionHandleAppendOptions,
  type SessionHandleFlushOptions,
  type SessionHandleReadOptions,
  type SessionHandleReadResult,
} from '@deepseek-ai/dsh-session-persistence'

/** Maximum intentional wait before a routed live batch starts writing. */
export const POSTGRES_LIVE_BATCH_MAX_DELAY_MS = 200

/** Normalize a caught value for an aggregate failure. */
function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/** Operations the handle drives on its owning service. */
export interface PostgresHandleStorage {
  /** Mark a pending Session as durable. */
  materialized(id: SessionId): void
  /** Read and validate one slice of a materialized Session's log. */
  readEvents(
    header: SessionHeader,
    id: SessionId,
    offset: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<readonly SessionEvent[]>
  /** Commit one contiguous batch and renew the writer lease; returns the new event count. */
  appendBatch(header: SessionHeader, id: SessionId, writerToken: string, events: readonly SessionEvent[]): Promise<number>
  /** Make a created-but-empty Session durably visible. */
  materializeSession(header: SessionHeader, id: SessionId, writerToken: string): Promise<void>
  /** Release the writer lease, deleting a never-materialized row. */
  releaseWriter(id: SessionId, writerToken: string, materialized: boolean): Promise<void>
  /** Renew the writer lease from database time. */
  renewWriter(id: SessionId, writerToken: string): Promise<'renewed' | 'lost'>
  /** Track a constructed handle for teardown and live routing. */
  adopt(handle: PostgresSessionHandle): PostgresSessionHandle
  /** Drop a closing handle's bookkeeping. */
  releaseHandle(handle: PostgresSessionHandle, materialized: boolean): void
}

/** Mutable per-handle state; a write handle is its Session's single mutator. */
export interface PostgresHandleState {
  /** Stored next-seq known to this handle. */
  cursor: number
  /** Whether the Session row is durably listable. */
  materialized: boolean
  /** Exact fork-inherited prefix length stored with the log. */
  inheritedEventCount: SessionLogOffset
}

/** One open channel onto a stored Postgres Session. */
export class PostgresSessionHandle implements SessionHandle {
  private chain: Promise<unknown> = Promise.resolve()
  private closing: Promise<void> | undefined
  private observedLength = 0
  private buffered: SessionEvent[] = []
  private batchTimer: ReturnType<typeof setTimeout> | undefined
  private drainPaused = false
  private draining: Promise<void> | undefined
  private lost = false
  private renewal: ReturnType<typeof setInterval> | undefined

  /**
   * @param storage - the owning service's storage primitive.
   * @param id - stored Session id.
   * @param header - immutable stored header.
   * @param access - read or write.
   * @param state - cursor and materialization state.
   * @param writerToken - lease token for a write handle.
   * @param renewIntervalMs - lease renewal interval for a write handle.
   */
  constructor(
    private readonly storage: PostgresHandleStorage,
    readonly id: SessionId,
    readonly header: SessionHeader,
    readonly access: SessionAccess,
    private readonly state: PostgresHandleState,
    private readonly writerToken?: string,
    renewIntervalMs?: number,
  ) {
    if (access === 'write' && writerToken !== undefined && renewIntervalMs !== undefined) {
      this.renewal = setInterval(() => {
        this.renew().catch(() => {
          // The database latches infrastructure failure; a lost lease stops
          // its own timer. Both cases surface on the next write.
        })
      }, renewIntervalMs)
      this.renewal.unref()
    }
  }

  /** Exact fork-inherited prefix length stored with this Session's log. */
  get inheritedEventCount(): SessionLogOffset {
    return this.state.inheritedEventCount
  }

  /**
   * Read a slice of the valid contiguous logical log.
   * @param offset - first logical event seq to include (default 0).
   * @param length - maximum events returned (default: the rest).
   * @param options - optional cancellation.
   * @returns the caller-owned slice.
   */
  async read(offset = 0, length = Number.MAX_SAFE_INTEGER, options?: SessionHandleReadOptions): Promise<SessionHandleReadResult> {
    this.assertOpen('read')
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new TypeError(`read offset must be a non-negative safe integer, got ${String(offset)}`)
    }
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new TypeError(`read length must be a non-negative safe integer, got ${String(length)}`)
    }
    options?.signal?.throwIfAborted()
    if (!this.state.materialized) return { eventState: 'detached', events: [] }
    const events = await this.storage.readEvents(this.header, this.id, offset, length, options?.signal)
    this.observedLength = Math.max(this.observedLength, offset + events.length)
    return { eventState: 'detached', events }
  }

  /**
   * Append a contiguous batch; see the persistence seam contract.
   * @param events - the contiguous batch in seq order.
   * @param options - optional cancellation observed before the write starts.
   */
  async append(events: readonly SessionEvent[], options?: SessionHandleAppendOptions): Promise<void> {
    const batch = events
    return this.run('append', async () => {
      options?.signal?.throwIfAborted()
      await this.persist(batch)
    })
  }

  /**
   * Durability barrier; materializes a created-but-empty Session.
   * @param options - optional cancellation observed before the barrier starts.
   */
  flush(options?: SessionHandleFlushOptions): Promise<void> {
    return this.run('flush', async () => {
      options?.signal?.throwIfAborted()
      if (this.access !== 'write') throw new SessionReadOnlyError(this.id, 'flush')
      if (this.state.materialized) return
      this.assertWritable('flush')
      await this.storage.materializeSession(this.header, this.id, this.writerToken ?? '')
      this.state.materialized = true
      this.storage.materialized(this.id)
    })
  }

  /**
   * Release the handle: drain routed live events, then release the writer
   * lease. Idempotent and uncancellable.
   * @returns settlement of the release.
   */
  close(): Promise<void> {
    return this.closing ??= this.settleClose()
  }

  /** Drain routed events, release the lease, and free local bookkeeping. */
  private async settleClose(): Promise<void> {
    this.stopRenewal()
    const failures = await this.drainBeforeClose()
    await this.chain
    await this.releaseLease(failures)
    this.storage.releaseHandle(this, this.state.materialized)
    if (failures.length > 1) {
      throw new AggregateError(failures, `session "${this.id}": close failed to drain and to release its writer lease`)
    }
    if (failures[0] !== undefined) throw failures[0]
  }

  private async drainBeforeClose(): Promise<Error[]> {
    try {
      await this.drainUntilEmpty()
      return []
    } catch (error: unknown) {
      return [asError(error)]
    }
  }

  private async drainUntilEmpty(): Promise<void> {
    for (;;) {
      await this.drainLive()
      await this.chain
      if (this.buffered.length === 0) return
    }
  }

  private async releaseLease(failures: Error[]): Promise<void> {
    if (this.access !== 'write' || this.writerToken === undefined) return
    try {
      await this.storage.releaseWriter(this.id, this.writerToken, this.state.materialized)
    } catch (error: unknown) {
      failures.push(asError(error))
    }
  }

  /** `await using` support: delegates to {@link close}. */
  [Symbol.asyncDispose](): Promise<void> {
    return this.close()
  }

  /**
   * Buffer one published live event and arm the bounded batching window.
   * @param event - the live event, retained as a persistence-owned copy.
   * @param reportBackgroundFailure - observes a deadline-driven drain failure.
   */
  enqueueLive(event: SessionEvent, reportBackgroundFailure: (error: unknown) => void): void {
    this.buffered.push(structuredClone(event))
    if (this.batchTimer !== undefined || this.drainPaused) return
    this.batchTimer = setTimeout(() => {
      this.batchTimer = undefined
      this.drainLive().catch(reportBackgroundFailure)
    }, POSTGRES_LIVE_BATCH_MAX_DELAY_MS)
  }

  /**
   * Durably drain the routed live buffer through the mutation chain.
   * @returns resolution when the buffer is empty.
   */
  drainLive(): Promise<void> {
    return this.draining ??= this.drainBuffered().finally(() => {
      this.draining = undefined
    })
  }

  private async drainBuffered(): Promise<void> {
    if (this.batchTimer !== undefined) {
      clearTimeout(this.batchTimer)
      this.batchTimer = undefined
    }
    this.drainPaused = false
    while (this.buffered.length > 0) {
      await this.enqueueChain(async () => {
        const batch = this.buffered.splice(0)
        try {
          await this.persist(batch)
        } catch (error: unknown) {
          this.buffered = batch.concat(this.buffered)
          this.drainPaused = true
          throw error
        }
      })
    }
  }

  private async persist(batch: readonly SessionEvent[]): Promise<void> {
    if (this.access !== 'write') throw new SessionReadOnlyError(this.id, 'append')
    if (batch.length === 0) return
    this.assertWritable('append')
    let cursor: number
    try {
      cursor = await this.storage.appendBatch(this.header, this.id, this.writerToken ?? '', batch)
    } catch (error: unknown) {
      if (error instanceof SessionOwnershipLostError) this.markLost()
      throw error
    }
    this.state.cursor = cursor
    this.state.materialized = true
    this.storage.materialized(this.id)
  }

  private async renew(): Promise<void> {
    if (this.closing !== undefined || this.lost || this.writerToken === undefined) return
    const outcome = await this.storage.renewWriter(this.id, this.writerToken)
    if (outcome === 'lost') this.markLost()
  }

  private markLost(): void {
    this.lost = true
    this.stopRenewal()
  }

  private stopRenewal(): void {
    if (this.renewal !== undefined) {
      clearInterval(this.renewal)
      this.renewal = undefined
    }
  }

  private assertWritable(operation: string): void {
    if (this.lost) throw new SessionOwnershipLostError(this.id)
    if (this.access !== 'write') throw new SessionReadOnlyError(this.id, operation)
  }

  private enqueueChain(operation: () => Promise<void>): Promise<void> {
    const next = this.chain.then(operation)
    this.chain = next.catch(() => {})
    return next
  }

  private async run(operation: string, op: () => Promise<void>): Promise<void> {
    this.assertOpen(operation)
    return this.enqueueChain(async () => {
      this.assertOpen(operation)
      return op()
    })
  }

  private assertOpen(operation: string): void {
    if (this.closing !== undefined) throw new SessionHandleClosedError(this.id, operation)
  }
}
