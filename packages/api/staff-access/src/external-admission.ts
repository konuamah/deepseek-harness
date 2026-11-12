/**
 * Non-owner Peer admission for staff Remote connections. Each admitted user's last authenticated session
 * cookie is held in memory; revocation disposes that user's Peer, cancels their Agent turns, invalidates
 * their access bindings, and drops the cookie. A sweep re-checks every held cookie with Django.
 *
 * @module @deepseek-ai/dsh-api-staff-access/src/external-admission
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-remote-access'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { ExternalAdmission, ExternalPeerAdmission } from '@deepseek-ai/dsh-client-connection'
import { findCookie, type DjangoStaffAuthenticator } from './django-authenticator.ts'
import type { StaffOwnershipReader } from './owner-index.ts'
import { staffPrincipal } from './principal.ts'
import type { StaffDecision, StaffIdentity } from './types.ts'

/** Most staff users held at once; admitting one more revokes the least recently admitted user. */
const MAX_HELD_USERS = 1000

/** Dependencies of one staff admission. */
export interface StaffAdmissionOptions {
  /** Authenticator that decides each request and each sweep re-check. */
  readonly authenticator: Pick<DjangoStaffAuthenticator, 'authenticate' | 'invalidateUser'>
  /** Session cookie name the held cookie values belong to. */
  readonly cookieName: string
  /** Ownership view that names the Sessions whose turns a revoke cancels. */
  readonly owners: StaffOwnershipReader
  /** Host services a revoke uses: Agents, the Connection, Remote access, and the logger. */
  readonly scope: Pick<Context, 'agents' | 'connection' | 'remoteAccess' | 'logger'>
  /** Called with the user id on every revoke, before the cookie is dropped (the AI token cache hooks in here). */
  readonly onRevoke?: (userId: number) => void
  /** Whether the ownership authority and chat storage can serve staff. */
  readonly available?: () => boolean
}

/** Admission provider plus the revocation and sweep it runs. */
export interface StaffAdmission extends ExternalPeerAdmission {
  /**
   * Revoke one staff user: cancel their turns, dispose their Peer, invalidate their bindings, and drop their
   * cookie. Every step runs even when an earlier one throws; calling it again is safe.
   * @param userId - Django user id to revoke.
   * @throws AggregateError when one or more steps threw; the message names the user and carries no cookie.
   */
  revokeStaff(userId: number): void
  /**
   * Re-check every held cookie with Django once, invalidating its cached decision first. A denial or a
   * changed identity revokes the user; a failed check fails closed.
   * @returns resolves when every held user has been checked.
   */
  sweep(): Promise<void>
  /**
   * The session cookie value held for a user.
   * @param userId - Django user id.
   * @returns the value, or undefined when none is held.
   */
  cookieFor(userId: number): string | undefined
  /** Drop every held cookie; later admissions and sweeps do nothing. */
  dispose(): void
  /**
   * Revoke every held user: cancel their turns, close their Peers, and drop
   * their cookies. Used when the chat database fails and every staff operation
   * must stop without waiting for the next request.
   * @param why - reason for the log line.
   */
  revokeAll(why: string): void
}

interface Held {
  readonly cookie: string
  readonly role: string
}

/**
 * Build the staff admission provider over one authenticator and one owner index.
 * @param options - authenticator, cookie name, owner index, and the Host services a revoke uses.
 * @returns the provider with its revocation and sweep.
 */
export function createStaffAdmission(options: StaffAdmissionOptions): StaffAdmission {
  const { authenticator, cookieName, owners, scope, onRevoke } = options
  const available = options.available ?? (() => true)
  const held = new Map<number, Held>()
  let disposed = false
  let sweeping: Promise<void> | undefined
  // A function call keeps the flag from being narrowed across the awaits below.
  const live = (): boolean => !disposed

  function revokeStaff(userId: number): void {
    const failures: unknown[] = []
    const attempt = (step: () => void): void => {
      try {
        step()
      } catch (error) {
        failures.push(error)
      }
    }
    attempt(() => { onRevoke?.(userId) })
    const entry = held.get(userId)
    for (const sessionId of owners.sessionsOf(userId)) {
      attempt(() => { scope.agents.get(sessionId)?.cancel({ kind: 'user' }, { keepInbox: true }) })
    }
    attempt(() => { scope.connection.disposeExternalPeer(peerKey(userId)) })
    // shortcut: the role is needed to name the principal; a user with no held cookie was already invalidated when revoked.
    if (entry !== undefined) {
      attempt(() => { scope.remoteAccess.invalidate(staffPrincipal({ userId, role: entry.role })) })
    }
    held.delete(userId)
    if (failures.length > 0) {
      throw new AggregateError(failures, `staff-access: revoking staff user ${userId} did not finish every step`)
    }
  }

  function revokeReported(userId: number, why: string): void {
    const cookie = held.get(userId)?.cookie
    scope.logger.warn(`staff-access: revoking staff user ${userId}: ${why}`)
    try {
      revokeStaff(userId)
    } catch (error) {
      scope.logger.error(
        `staff-access: revoke of staff user ${userId} did not finish (${describe(error, cookie)}). `
        + 'The remaining steps ran, but the Peer or running turns may still be live and no retry is scheduled. Restart the Host to clear them.',
      )
    }
  }

  function remember(userId: number, cookie: string, role: string): void {
    held.delete(userId)
    held.set(userId, { cookie, role })
    if (held.size > MAX_HELD_USERS) {
      const oldest = held.keys().next().value
      if (oldest !== undefined) revokeReported(oldest, 'too many staff users are held')
    }
  }

  function userHoldingCookie(cookie: string): number | undefined {
    for (const [userId, entry] of held) {
      if (entry.cookie === cookie) return userId
    }
    return undefined
  }

  /** Revoke the earlier holder of this cookie, and the held user whose role changed, before a fresh admission. */
  function reconcile(identity: StaffIdentity, cookie: string): void {
    const prior = userHoldingCookie(cookie)
    if (prior !== undefined && prior !== identity.userId) revokeReported(prior, 'the session now belongs to another user')
    const current = held.get(identity.userId)
    if (current !== undefined && current.role !== identity.role) revokeReported(identity.userId, 'the role changed')
  }

  async function admit(headers: Readonly<Record<string, string | string[] | undefined>>): Promise<ExternalAdmission> {
    const cookie = findCookie(headers.cookie, cookieName)
    if (!live() || !available() || cookie === undefined) return { kind: 'deny' }
    let decision: StaffDecision
    try {
      decision = await authenticator.authenticate(headers)
    } catch {
      decision = { kind: 'deny', reason: 'unavailable' }
    }
    // The database may have failed while Django answered: re-check before
    // caching a decision or announcing an allowed Peer.
    if (!live() || !available()) return { kind: 'deny' }
    const identity = allowedIdentity(decision)
    if (identity === undefined) {
      const owner = userHoldingCookie(cookie)
      if (owner !== undefined) revokeReported(owner, 'Django denied the held session')
      return { kind: 'deny' }
    }
    reconcile(identity, cookie)
    remember(identity.userId, cookie, identity.role)
    return { kind: 'allow', key: peerKey(identity.userId), principal: staffPrincipal(identity) }
  }

  async function recheck(userId: number, entry: Held): Promise<void> {
    if (held.get(userId) !== entry) return
    let decision: StaffDecision
    try {
      authenticator.invalidateUser(userId)
      decision = await authenticator.authenticate({ cookie: `${cookieName}=${entry.cookie}` })
    } catch {
      decision = { kind: 'deny', reason: 'unavailable' }
    }
    if (held.get(userId) !== entry) return
    if (decision.kind === 'deny') {
      revokeReported(userId, `the sweep re-check was denied (${decision.reason})`)
      return
    }
    const identity: StaffIdentity = decision.identity
    if (identity.userId === userId && identity.role === entry.role) return
    revokeReported(userId, 'the identity or role changed')
    if (isUserId(identity.userId)) remember(identity.userId, entry.cookie, identity.role)
  }

  return {
    admit,
    revokeStaff,
    cookieFor: userId => held.get(userId)?.cookie,
    sweep() {
      if (disposed) return Promise.resolve()
      sweeping ??= Promise.all([...held].map(([userId, entry]) => recheck(userId, entry)))
        .then(() => undefined)
        .finally(() => { sweeping = undefined })
      return sweeping
    },
    dispose() {
      disposed = true
      held.clear()
    },
    revokeAll(why) {
      for (const userId of [...held.keys()]) revokeReported(userId, why)
    },
  }
}

/**
 * Peer key of one staff user; the Connection shares one Peer per key.
 * @param userId - Django user id.
 * @returns the key `staff:<userId>`.
 */
function peerKey(userId: number): string {
  return `staff:${userId}`
}

/**
 * The identity of an allow decision whose user id the owner index accepts.
 * @param decision - authenticator answer for one request or re-check.
 * @returns the identity, or undefined for a deny or an unusable user id.
 */
function allowedIdentity(decision: StaffDecision): StaffIdentity | undefined {
  if (decision.kind !== 'allow') return undefined
  return isUserId(decision.identity.userId) ? decision.identity : undefined
}

/**
 * Whether a value is a user id the owner index and the Peer key accept.
 * @param value - candidate user id from Django.
 * @returns true for a positive safe integer.
 */
function isUserId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/**
 * Describe an error for a log line, with the held cookie value removed from the text.
 * @param error - the caught value.
 * @param cookie - the held cookie value of the user being revoked, if any.
 * @returns the message text without the cookie value.
 */
function describe(error: unknown, cookie: string | undefined): string {
  const text = error instanceof AggregateError
    ? `${error.message}: ${error.errors.map(member => describe(member, undefined)).join('; ')}`
    : error instanceof Error ? error.message : 'non-error value'
  return cookie === undefined || cookie === '' ? text : text.split(cookie).join('[redacted]')
}
