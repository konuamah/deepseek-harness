/**
 * In-process bookkeeping for the Postgres provider: pending created Sessions,
 * the one active write route per Session id, and the teardown sweep.
 * @module @deepseek-ai/dsh-session-persistence-postgres/tracker
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionHeader, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import {
  SessionHandleClosedError,
  SessionPersistenceRevision,
} from '@deepseek-ai/dsh-session-persistence'
import type { PostgresSessionHandle } from './storage.ts'

/** One created-but-unmaterialized Session tracked in this process only. */
export interface PendingSession {
  readonly header: SessionHeader
  readonly revision: SessionPersistenceRevision
  readonly inheritedEventCount: SessionLogOffset
}

/** The provider's in-process bookkeeping and teardown. */
export class PostgresBackendTracker {
  /** Every open handle; teardown closes what remains. */
  readonly openHandles = new Set<PostgresSessionHandle>()
  /** `null` marks a claim whose handle is still being constructed. */
  private readonly writers = new Map<SessionId, PostgresSessionHandle | null>()
  private readonly pending = new Map<SessionId, PendingSession>()
  private counter = 0

  /** @param name - backend label used in revisions and teardown errors. */
  constructor(private readonly name: string) {}

  /**
   * Record a created Session as visible to this process before its row is listable elsewhere.
   * @param header - the validated header.
   * @param inheritedEventCount - the exact fork-inherited prefix length.
   * @throws {Error} when the id is already pending here.
   */
  registerCreated(header: SessionHeader, inheritedEventCount: SessionLogOffset): void {
    if (this.pending.has(header.id)) throw new Error(`session "${header.id}" is already pending`)
    this.writers.set(header.id, null)
    this.pending.set(header.id, {
      header,
      revision: SessionPersistenceRevision(`postgres-pending:${this.name}:${++this.counter}`),
      inheritedEventCount,
    })
  }

  /** The pending entry for a created Session, if any. */
  pendingOf(id: SessionId): PendingSession | undefined {
    return this.pending.get(id)
  }

  /** Whether this process tracks a created-but-unmaterialized Session. */
  hasPending(id: SessionId): boolean {
    return this.pending.has(id)
  }

  /** Iterate pending Sessions for listing. */
  pendingEntries(): IterableIterator<[SessionId, PendingSession]> {
    return this.pending.entries()
  }

  /** Drop a pending entry once its row is durably materialized. */
  materialized(id: SessionId): void {
    this.pending.delete(id)
  }

  /**
   * Track one open handle and bind a write handle as its Session's live route.
   * @param handle - the just-constructed handle.
   * @returns the same handle.
   */
  adopt(handle: PostgresSessionHandle): PostgresSessionHandle {
    this.openHandles.add(handle)
    if (handle.access === 'write') this.writers.set(handle.id, handle)
    return handle
  }

  /**
   * Drop a closing handle's bookkeeping.
   * @param handle - the closing handle.
   * @param materialized - whether the Session row is durable.
   */
  releaseHandle(handle: PostgresSessionHandle, materialized: boolean): void {
    this.openHandles.delete(handle)
    if (handle.access !== 'write') return
    this.writers.delete(handle.id)
    if (!materialized) this.pending.delete(handle.id)
  }

  /**
   * Flush every active write handle in one barrier.
   * @throws {AggregateError} naming each Session whose flush failed.
   */
  async flushAll(): Promise<void> {
    const errors: unknown[] = []
    for (const writer of [...this.writers.values()]) {
      if (writer === null) continue
      try {
        await writer.drainLive()
        await writer.flush()
      } catch (error: unknown) {
        if (error instanceof SessionHandleClosedError) continue
        errors.push(error)
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, `${this.name} flush failed`)
  }

  /**
   * Install live Session routing and teardown. The returned effect removes
   * listeners before closing handles; close drains their routed buffers.
   * @param ctx - the provider's resource-owning context.
   * @returns the disposer.
   */
  install(ctx: Context): () => Promise<void> {
    const { writers, openHandles, name } = this
    return ctx.effect(function* () {
      yield async () => {
        const errors: unknown[] = []
        for (const handle of [...openHandles]) {
          try {
            await handle.close()
          } catch (error: unknown) {
            errors.push(error)
          }
        }
        if (errors.length > 0) throw new AggregateError(errors, `${name} dispose failed`)
      }
      yield ctx.on('session/event', (session: Session, event) => {
        writers.get(session.id)?.enqueueLive(event, (error) => {
          ctx.logger.warn(`session-persistence-postgres: background write for session "${session.id}" failed (buffered events retained): ${String(error)}`)
        })
      })
      yield ctx.on('session/flush', (session: Session) => {
        const writer = writers.get(session.id)
        if (writer === null || writer === undefined) return undefined
        return (async () => {
          await writer.drainLive()
          await writer.flush()
        })()
      })
      yield ctx.on('session/disposed', (session: Session) => {
        const writer = writers.get(session.id)
        if (writer === null || writer === undefined) return
        writer.close().catch((error: unknown) => {
          ctx.logger.warn(`session-persistence-postgres: final drain for session "${session.id}" failed: ${String(error)}`)
        })
      })
    }, `${name} live routing and open handles`)
  }
}
