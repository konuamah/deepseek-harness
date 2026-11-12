/**
 * The Postgres-backed `ctx.sessionPersistence` service: storage commits,
 * materialized reads, and the in-process pending view.
 * @module @deepseek-ai/dsh-session-persistence-postgres/service
 */

import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import type { SessionEvent, SessionHeader, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { SessionId as makeSessionId, SessionLogOffset as makeSessionLogOffset } from '@deepseek-ai/dsh-session'
import {
  SessionPersistence,
  SessionPersistenceRevision,
  SessionAlreadyExistsError,
  SessionAlreadyOwnedError,
  SessionOwnershipLostError,
  SessionPersistenceNotFoundError,
  assertContiguous,
  materializeAppendBatch,
  materializeCreateHeader,
  validateStoredEvents,
  type SessionAccess,
  type SessionHandle,
  type SessionPersistenceCreateOptions,
  type SessionPersistenceListOptions,
  type SessionPersistenceOpenOptions,
  type SessionPersistenceSnapshot,
  type SessionPersistenceStatOptions,
} from '@deepseek-ai/dsh-session-persistence'
import { corruption, decodeEvent, decodeHeader, isUniqueViolation, resolveInherited } from './codec.ts'
import type { Settings } from './index.ts'
import type { PostgresDatabase } from './database.ts'
import type { SessionOwnership } from './ownership.ts'
import { PostgresSessionHandle, type PostgresHandleStorage } from './storage.ts'
import type { PostgresBackendTracker } from './tracker.ts'

/** Largest event slice `seq >= offset LIMIT length` can express. */
const MAX_EVENT_LIMIT = 2_147_483_647

/** One stored Session row used by reads and opens. */
interface StoredSession {
  readonly header: SessionHeader
  readonly inheritedEventCount: SessionLogOffset
  readonly eventCount: number
  readonly revision: string
}

/** The Postgres-backed service registered as `ctx.sessionPersistence`. */
export class PostgresSessionPersistence extends SessionPersistence implements PostgresHandleStorage {
  /** Backend label for diagnostics; does not change the service key. */
  override readonly name = 'session-persistence-postgres'

  /**
   * @param ctx - service context.
   * @param database - the provider pool.
   * @param tracker - in-process pending and live-route bookkeeping.
   * @param ownership - the DB-backed staff ownership view.
   * @param settings - validated lease and timeout settings.
   */
  constructor(
    ctx: Context,
    private readonly database: PostgresDatabase,
    private readonly tracker: PostgresBackendTracker,
    private readonly ownership: SessionOwnership,
    private readonly settings: Settings,
  ) {
    super(ctx)
  }

  // --- SessionPersistence service API ---

  async create(header: SessionHeader, options?: SessionPersistenceCreateOptions): Promise<SessionHandle> {
    options?.signal?.throwIfAborted()
    const snapshot = materializeCreateHeader(header)
    const inherited = resolveInherited(snapshot, options)
    if (this.tracker.hasPending(snapshot.id)) throw new SessionAlreadyExistsError(snapshot.id)
    // The reservation is consumed synchronously, before any await, so the
    // create attempt that wins carries the staff owner or no owner at all.
    const owner = this.ownership.takeReservation(snapshot.id)
    const writerToken = randomUUID()
    options?.signal?.throwIfAborted()
    try {
      await this.insertSession(snapshot, inherited, owner, writerToken)
    } catch (error: unknown) {
      if (isUniqueViolation(error)) throw new SessionAlreadyExistsError(snapshot.id)
      throw error
    }
    this.tracker.registerCreated(snapshot, inherited)
    if (owner !== undefined) this.ownership.publish(snapshot.id, owner)
    return this.tracker.adopt(new PostgresSessionHandle(
      this,
      snapshot.id,
      snapshot,
      'write',
      { cursor: 0, materialized: false, inheritedEventCount: inherited },
      writerToken,
      this.settings.renewIntervalMs,
    ))
  }

  async open(id: SessionId, access: SessionAccess, options?: SessionPersistenceOpenOptions): Promise<SessionHandle> {
    options?.signal?.throwIfAborted()
    const pending = this.tracker.pendingOf(id)
    if (pending !== undefined) {
      if (access === 'write') throw new SessionAlreadyOwnedError(id)
      return this.tracker.adopt(new PostgresSessionHandle(
        this, id, pending.header, 'read',
        { cursor: 0, materialized: false, inheritedEventCount: pending.inheritedEventCount },
      ))
    }
    if (access === 'read') {
      const stored = await this.loadStoredSession(id)
      if (stored === undefined) throw new SessionPersistenceNotFoundError(id)
      return this.tracker.adopt(new PostgresSessionHandle(
        this, id, stored.header, 'read',
        { cursor: stored.eventCount, materialized: true, inheritedEventCount: stored.inheritedEventCount },
      ))
    }
    const writerToken = randomUUID()
    const stored = await this.claimWriter(id, writerToken)
    try {
      // A write open interprets the whole log, so unknown vocabulary refuses
      // here rather than after a mutation; the claim is released on refusal.
      await this.readEvents(stored.header, id, 0, MAX_EVENT_LIMIT)
    } catch (error: unknown) {
      await this.releaseWriter(id, writerToken, true).catch(() => {
        // The read refusal is the reported failure; an unreleased lease expires on its own.
      })
      throw error
    }
    return this.tracker.adopt(new PostgresSessionHandle(
      this, id, stored.header, 'write',
      { cursor: stored.eventCount, materialized: true, inheritedEventCount: stored.inheritedEventCount },
      writerToken,
      this.settings.renewIntervalMs,
    ))
  }

  flush(): Promise<void> {
    return this.tracker.flushAll()
  }

  async stat(id: SessionId, options?: SessionPersistenceStatOptions): Promise<SessionPersistenceSnapshot | undefined> {
    options?.signal?.throwIfAborted()
    const pending = this.tracker.pendingOf(id)
    if (pending !== undefined) return { header: pending.header, revision: pending.revision }
    const stored = await this.loadStoredSession(id)
    options?.signal?.throwIfAborted()
    if (stored === undefined) return undefined
    return {
      header: stored.header,
      revision: SessionPersistenceRevision(`postgres:${stored.revision}`),
      eventCount: stored.eventCount,
    }
  }

  async list(options?: SessionPersistenceListOptions): Promise<readonly SessionPersistenceSnapshot[]> {
    const signal = options?.signal
    signal?.throwIfAborted()
    const rows = await this.database.query<{
      id: string
      header: string
      event_count: number
      revision: string
    }>(
      `SELECT id, header, event_count, revision::text AS revision
       FROM dsh_sessions WHERE materialized ORDER BY id`,
    )
    signal?.throwIfAborted()
    const snapshots = new Map<SessionId, SessionPersistenceSnapshot>()
    for (const row of rows) {
      const id = makeSessionId(row.id)
      snapshots.set(id, {
        header: decodeHeader(id, row.header),
        revision: SessionPersistenceRevision(`postgres:${row.revision}`),
        eventCount: row.event_count,
      })
    }
    for (const [id, pending] of this.tracker.pendingEntries()) {
      if (!snapshots.has(id)) snapshots.set(id, { header: pending.header, revision: pending.revision })
    }
    return [...snapshots.values()]
  }

  // --- PostgresHandleStorage ---

  materialized(id: SessionId): void {
    this.tracker.materialized(id)
  }

  adopt(handle: PostgresSessionHandle): PostgresSessionHandle {
    return this.tracker.adopt(handle)
  }

  releaseHandle(handle: PostgresSessionHandle, materialized: boolean): void {
    this.tracker.releaseHandle(handle, materialized)
  }

  async readEvents(
    header: SessionHeader,
    id: SessionId,
    offset: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<readonly SessionEvent[]> {
    const limit = Math.min(length, MAX_EVENT_LIMIT)
    const rows = await this.database.query<{ seq: number; payload: string }>(
      `SELECT seq, payload FROM dsh_session_events
       WHERE session_id = $1 AND seq >= $2 ORDER BY seq LIMIT $3`,
      [id, offset, limit],
    )
    signal?.throwIfAborted()
    const events: SessionEvent[] = []
    for (const [index, row] of rows.entries()) {
      if (row.seq !== offset + index) {
        throw corruption(id, `event sequence (expected ${offset + index}, found ${row.seq})`)
      }
      events.push(decodeEvent(id, row.seq, row.payload))
    }
    return validateStoredEvents(header, events)
  }

  async appendBatch(
    _header: SessionHeader,
    id: SessionId,
    writerToken: string,
    events: readonly SessionEvent[],
  ): Promise<number> {
    const batch = materializeAppendBatch(events)
    return this.database.withTransaction(async (client) => {
      const locked = await client.query<{ event_count: number; writing: boolean }>(
        `SELECT event_count,
                (writer_id = $2 AND writer_expires_at IS NOT NULL AND writer_expires_at > now()) AS writing
         FROM dsh_sessions WHERE id = $1 FOR UPDATE`,
        [id, writerToken],
      )
      const row = locked.rows[0]
      if (row === undefined) throw new SessionPersistenceNotFoundError(id)
      if (!row.writing) throw new SessionOwnershipLostError(id)
      assertContiguous(id, batch, row.event_count)
      await client.query(
        `INSERT INTO dsh_session_events (session_id, seq, payload)
         SELECT $1, batch.seq, batch.payload
         FROM unnest($2::integer[], $3::text[]) AS batch(seq, payload)`,
        [id, batch.map(event => event.seq as number), batch.map(event => JSON.stringify(event))],
      )
      const updated = await client.query(
        `UPDATE dsh_sessions
         SET event_count = event_count + $2,
             revision = revision + 1,
             materialized = true,
             writer_expires_at = now() + ($3::integer * interval '1 millisecond'),
             updated_at = now()
         WHERE id = $1 AND writer_id = $4`,
        [id, batch.length, this.settings.leaseMs, writerToken],
      )
      if (updated.rowCount !== 1) throw new SessionOwnershipLostError(id)
      return row.event_count + batch.length
    })
  }

  async materializeSession(_header: SessionHeader, id: SessionId, writerToken: string): Promise<void> {
    const updated = await this.database.query(
      `UPDATE dsh_sessions
       SET materialized = true,
           writer_expires_at = now() + ($3::integer * interval '1 millisecond'),
           updated_at = now()
       WHERE id = $1 AND writer_id = $2
       RETURNING id`,
      [id, writerToken, this.settings.leaseMs],
    )
    if (updated.length === 0) throw new SessionOwnershipLostError(id)
  }

  async releaseWriter(id: SessionId, writerToken: string, materialized: boolean): Promise<void> {
    if (materialized) {
      await this.database.query(
        `UPDATE dsh_sessions SET writer_id = NULL, writer_expires_at = NULL, updated_at = now()
         WHERE id = $1 AND writer_id = $2`,
        [id, writerToken],
      )
      return
    }
    // A created Session that never became durable never existed.
    await this.database.query(
      'DELETE FROM dsh_sessions WHERE id = $1 AND writer_id = $2 AND materialized = false',
      [id, writerToken],
    )
  }

  async renewWriter(id: SessionId, writerToken: string): Promise<'renewed' | 'lost'> {
    const updated = await this.database.query(
      `UPDATE dsh_sessions
       SET writer_expires_at = now() + ($3::integer * interval '1 millisecond')
       WHERE id = $1 AND writer_id = $2 AND writer_expires_at > now()
       RETURNING id`,
      [id, writerToken, this.settings.leaseMs],
    )
    return updated.length === 1 ? 'renewed' : 'lost'
  }

  // --- storage internals ---

  /** Insert a created Session row in one transaction, consuming any reservation owner. */
  private async insertSession(
    header: SessionHeader,
    inheritedEventCount: SessionLogOffset,
    owner: number | undefined,
    writerToken: string,
  ): Promise<void> {
    await this.database.withTransaction(async (client) => {
      // A crashed process leaves an unmaterialized row behind; once its lease
      // has expired the id is free again, matching an erased never-materialized Session.
      await client.query(
        `DELETE FROM dsh_sessions
         WHERE id = $1 AND materialized = false
           AND (writer_id IS NULL OR writer_expires_at < now())`,
        [header.id],
      )
      await client.query(
        `INSERT INTO dsh_sessions
           (id, owner_id, header, inherited_event_count, event_count, revision,
            materialized, writer_id, writer_expires_at)
         VALUES ($1, $2, $3, $4, 0, 1, false, $5,
                 now() + ($6::integer * interval '1 millisecond'))`,
        [header.id, owner ?? null, JSON.stringify(header), inheritedEventCount, writerToken, this.settings.leaseMs],
      )
    })
  }

  /** Load one materialized Session header and counts. */
  private async loadStoredSession(id: SessionId): Promise<StoredSession | undefined> {
    const rows = await this.database.query<{
      header: string
      inherited_event_count: number
      event_count: number
      revision: string
    }>(
      `SELECT header, inherited_event_count, event_count, revision::text AS revision
       FROM dsh_sessions WHERE id = $1 AND materialized`,
      [id],
    )
    const row = rows[0]
    if (row === undefined) return undefined
    return this.decodeStoredSession(id, row)
  }

  /** Atomically claim the single writer lease for one materialized Session. */
  private async claimWriter(id: SessionId, writerToken: string): Promise<StoredSession> {
    return this.database.withTransaction(async (client) => {
      const selected = await client.query<{
        header: string
        inherited_event_count: number
        event_count: number
        revision: string
        writer_id: string | null
        live: boolean
        materialized: boolean
      }>(
        `SELECT header, inherited_event_count, event_count, revision::text AS revision,
                writer_id, (writer_expires_at > now()) AS live, materialized
         FROM dsh_sessions WHERE id = $1 FOR UPDATE`,
        [id],
      )
      const row = selected.rows[0]
      if (row === undefined || !row.materialized) throw new SessionPersistenceNotFoundError(id)
      if (row.writer_id !== null && row.live) throw new SessionAlreadyOwnedError(id)
      await client.query(
        `UPDATE dsh_sessions
         SET writer_id = $2, writer_expires_at = now() + ($3::integer * interval '1 millisecond'), updated_at = now()
         WHERE id = $1`,
        [id, writerToken, this.settings.leaseMs],
      )
      return this.decodeStoredSession(id, row)
    })
  }

  private decodeStoredSession(id: SessionId, row: {
    header: string
    inherited_event_count: number
    event_count: number
    revision: string
  }): StoredSession {
    if (!Number.isSafeInteger(row.inherited_event_count) || row.inherited_event_count < 0) {
      throw corruption(id, 'inherited event count')
    }
    if (!Number.isSafeInteger(row.event_count) || row.event_count < 0) {
      throw corruption(id, 'event count')
    }
    const header = decodeHeader(id, row.header)
    const inheritedEventCount = makeSessionLogOffset(row.inherited_event_count)
    if (!header.isSeeded && inheritedEventCount !== 0) throw corruption(id, 'inherited event count')
    return { header, inheritedEventCount, eventCount: row.event_count, revision: row.revision }
  }
}
