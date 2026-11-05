/**
 * Holds the list announcements of a Session created for a non-owner caller until its creation settles. The
 * announcement of a Session precedes the owner record that staff access needs to deliver it, so the create
 * defers it: a successful create releases it, and a failed create discards it with no announcement.
 *
 * @module @deepseek-ai/dsh-api-session-controller/src/create-announcements
 */

import type { SessionId } from '@deepseek-ai/dsh-session'

/** Announcement state of one held Session: waiting for its create, or refused after a failed create. */
type HoldState = 'held' | 'discarded'

/** Suppresses and releases the list announcements of Sessions whose creation has not settled. */
export class CreateAnnouncements {
  private readonly states = new Map<SessionId, HoldState>()

  /**
   * @param announce - announces the Session's current list row; called once per released Session that is still live.
   */
  constructor(private readonly announce: (sessionId: SessionId) => void) {}

  /**
   * Hold the announcements of a Session whose creation begins now.
   * @param sessionId - Session identity the create names before any Agent exists.
   */
  hold(sessionId: SessionId): void {
    this.states.set(sessionId, 'held')
  }

  /**
   * Whether a Session's list announcements are suppressed.
   * @param sessionId - Session identity whose announcement is about to be emitted.
   * @returns true while the Session is held or discarded.
   */
  suppresses(sessionId: SessionId): boolean {
    return this.states.has(sessionId)
  }

  /**
   * Stop holding a Session whose create succeeded, and announce it.
   * @param sessionId - Session identity whose create settled successfully.
   */
  release(sessionId: SessionId): void {
    this.states.delete(sessionId)
    this.announce(sessionId)
  }

  /**
   * Suppress every announcement of a Session whose create failed, until {@link forget}.
   * @param sessionId - Session identity whose create failed.
   */
  discard(sessionId: SessionId): void {
    this.states.set(sessionId, 'discarded')
  }

  /**
   * Drop the suppression state of a Session once its failed create has finished disposing it.
   * @param sessionId - Session identity whose create failed.
   */
  forget(sessionId: SessionId): void {
    this.states.delete(sessionId)
  }
}
