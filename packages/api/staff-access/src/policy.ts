/**
 * Remote access policy for staff callers: a global role every staff user holds, and one per-Session role
 * on each Session the user owns directly.
 *
 * Deny by default. Nothing is bound unless listed here, so a Remote method outside the two roles is refused
 * for staff without a denied-name list. The per-Session role re-checks ownership on every decision, so a
 * Session the owner index no longer assigns to the user is refused at once.
 *
 * @module @deepseek-ai/dsh-api-staff-access/src/policy
 */

import type {
  RemoteAccessBinding,
  RemoteAccessCondition,
  RemoteAccessDecision,
  RemoteAccessPolicy,
  RemoteAccessRole,
} from '@deepseek-ai/dsh-api-remote-access/types'
import type { SessionOwnerIndex } from './owner-index.ts'
import type { StaffPrincipal } from './principal.ts'

/** Options for {@link createStaffPolicy}. */
export interface StaffPolicyOptions {
  /** Owner index that names each user's Sessions and re-checks ownership on each decision. */
  readonly owners: SessionOwnerIndex
}

/** Global calls every staff user may make. */
const STAFF_GLOBAL_ROLE: RemoteAccessRole<'global'> = {
  name: 'staff:global',
  resource: 'global',
  actions: [
    'session/list',
    'session/create',
    'commands/list',
    'workspace/follow',
    'session/control',
  ],
}

/**
 * Calls on one Session the staff user owns. `session/list` is here on purpose: the session list method
 * filters each item through `allows({ kind: 'session', id })`, which needs a session binding that lists it.
 */
const STAFF_OWNED_SESSION_ROLE: RemoteAccessRole<'session'> = {
  name: 'staff:owned-session',
  resource: 'session',
  actions: [
    'commands/list',
    'goals/get',
    'skills/list',
    'session/list',
    'session/prompt',
    'session/cancel',
    'session/follow',
    'session/page',
    'session/projections',
    'session/observeProjections',
    'session/observeEvent',
    'session/observeState',
    'session/state',
    'session/events',
    'session/wait',
    'session/attachment',
    'session/rename',
    'session/updateQueue',
    'toolResults/watch',
    'event:api-session/activity',
    'event:api-session/added',
    'event:api-session/error',
    'event:api-session/removed',
    'event:api-session/status',
  ],
}

const ALLOW: RemoteAccessDecision = Object.freeze({ kind: 'allow' })
const NOT_OWNED: RemoteAccessDecision = Object.freeze({ kind: 'deny', reason: 'session-not-owned' })

/**
 * Build the staff access policy over one owner index.
 * @param options - The owner index the policy reads on every decision.
 * @returns The policy to register under the `staff` principal kind.
 */
export function createStaffPolicy(options: StaffPolicyOptions): RemoteAccessPolicy<StaffPrincipal> {
  const { owners } = options
  return {
    bindings(staff) {
      const bindings: RemoteAccessBinding[] = [{ role: STAFF_GLOBAL_ROLE, resource: { kind: 'global' } }]
      const ownedBy: RemoteAccessCondition<'session'> = ({ resource }) =>
        owners.ownerOf(resource.id) === staff.userId ? ALLOW : NOT_OWNED
      for (const sessionId of owners.sessionsOf(staff.userId)) {
        bindings.push({ role: STAFF_OWNED_SESSION_ROLE, resource: { kind: 'session', id: sessionId }, condition: ownedBy })
      }
      return bindings
    },
  }
}
