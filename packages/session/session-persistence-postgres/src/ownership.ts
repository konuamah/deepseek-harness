/**
 * The database-backed staff ownership authority and its lifecycle-owned
 * synchronous read view. The committed `owner_id` column is the only durable
 * authority; the view is hydrated before staff admission and changes only
 * after a create transaction commits. Short-lived reservations let the staff
 * create path bind the exact fresh Session id to the authenticated user
 * before the provider inserts the row.
 * @module @deepseek-ai/dsh-session-persistence-postgres/ownership
 */

import { SessionId } from '@deepseek-ai/dsh-session'
import type { PostgresAvailability } from './availability.ts'
import type { PostgresDatabase } from './database.ts'

/** Owner lookup and create-time reservation capability consumed by staff access. */
export interface PostgresOwnershipService {
  /** The staff user who owns a Session, or undefined when it has none. */
  ownerOf(sessionId: SessionId): number | undefined
  /** Sessions a user owns directly, in insertion order. */
  sessionsOf(userId: number): SessionId[]
  /** Whether the database lifecycle is ready to serve staff. */
  ready(): boolean
  /**
   * Reserve one fresh Session id for a user until its create consumes the
   * reservation or the caller releases it.
   * @param sessionId - the id the create will use.
   * @param userId - positive safe-integer Django user id.
   * @returns a release closure, safe to call more than once.
   */
  reserve(sessionId: SessionId, userId: number): () => Promise<void>
  /** Whether the committed row for `sessionId` names `userId` as owner. */
  verify(sessionId: SessionId, userId: number): Promise<boolean>
  /** Observe the first latched database failure. */
  onUnavailable(listener: () => void): () => void
}

interface Reservation {
  readonly userId: number
  readonly token: symbol
}

/** Whether a value is a positive safe integer accepted as an owner id. */
function isUserId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/** Resolve the committed owner of one stored Session, or undefined when unowned. */
async function committedOwner(database: PostgresDatabase, sessionId: SessionId): Promise<number | undefined> {
  const rows = await database.query<{ owner_id: string | null }>(
    'SELECT owner_id::text AS owner_id FROM dsh_sessions WHERE id = $1',
    [sessionId],
  )
  const owner = rows[0]?.owner_id
  if (owner === null || owner === undefined) return undefined
  const value = Number(owner)
  return isUserId(value) ? value : undefined
}

/** Hydrating, synchronously readable ownership view with create reservations. */
export class SessionOwnership implements PostgresOwnershipService {
  private readonly owners = new Map<SessionId, number>()
  private readonly reservations = new Map<SessionId, Reservation>()

  /** @param database - the committed authority. @param availability - the readiness source. */
  constructor(
    private readonly database: PostgresDatabase,
    private readonly availability: PostgresAvailability,
  ) {}

  /** Load every materialized owned Session before staff admission starts. */
  async hydrate(): Promise<void> {
    const rows = await this.database.query<{ id: string; owner_id: string }>(
      'SELECT id, owner_id::text AS owner_id FROM dsh_sessions WHERE materialized AND owner_id IS NOT NULL',
    )
    for (const row of rows) {
      const owner = Number(row.owner_id)
      if (isUserId(owner)) this.owners.set(SessionId(row.id), owner)
    }
  }

  ownerOf(sessionId: SessionId): number | undefined {
    return this.owners.get(sessionId)
  }

  sessionsOf(userId: number): SessionId[] {
    if (!isUserId(userId)) return []
    const result: SessionId[] = []
    for (const [sessionId, owner] of this.owners) {
      if (owner === userId) result.push(sessionId)
    }
    return result
  }

  ready(): boolean {
    return this.availability.ready()
  }

  reserve(sessionId: SessionId, userId: number): () => Promise<void> {
    if (!isUserId(userId)) throw new Error('staff-access: user id must be a positive safe integer')
    const existing = this.reservations.get(sessionId)
    if (existing !== undefined) {
      if (existing.userId !== userId) throw new Error('staff-access: session is reserved by another user')
      return () => this.releaseReservation(sessionId, existing.token)
    }
    if (this.owners.has(sessionId)) throw new Error('staff-access: session already exists')
    const reservation: Reservation = { userId, token: Symbol(sessionId) }
    this.reservations.set(sessionId, reservation)
    return () => this.releaseReservation(sessionId, reservation.token)
  }

  /**
   * Consume the reservation for an id being created. The provider calls this
   * synchronously, before any await, so the create that wins the race is the
   * one that carries the owner.
   * @param sessionId - the id the provider is about to insert.
   * @returns the reserved owner, or undefined for an ordinary owner-created Session.
   */
  takeReservation(sessionId: SessionId): number | undefined {
    const reservation = this.reservations.get(sessionId)
    if (reservation === undefined) return undefined
    this.reservations.delete(sessionId)
    return reservation.userId
  }

  /** Publish a committed owner into the synchronous view. */
  publish(sessionId: SessionId, userId: number): void {
    this.owners.set(sessionId, userId)
  }

  /**
   * Drop the owners of Sessions deleted by retention.
   * @param sessionIds - the committed deletes.
   */
  forget(sessionIds: readonly SessionId[]): void {
    for (const sessionId of sessionIds) this.owners.delete(sessionId)
  }

  async verify(sessionId: SessionId, userId: number): Promise<boolean> {
    const owner = await committedOwner(this.database, sessionId)
    if (owner !== userId) return false
    this.owners.set(sessionId, userId)
    return true
  }

  onUnavailable(listener: () => void): () => void {
    return this.availability.onUnavailable(listener)
  }

  private async releaseReservation(sessionId: SessionId, token: symbol): Promise<void> {
    if (this.reservations.get(sessionId)?.token === token) this.reservations.delete(sessionId)
  }
}
