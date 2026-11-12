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
import type { StaffOwnershipReader } from './owner-index.ts'
import type { StaffPrincipal } from './principal.ts'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'

/** Options for {@link createStaffPolicy}. */
export interface StaffPolicyOptions {
  /** Ownership view that names each user's Sessions and re-checks ownership on each decision. */
  readonly ownership: StaffOwnershipReader
  /** The shared staff Workspace id, or undefined until the plugin has registered it; no Workspace is bound while undefined. */
  readonly workspaceId: () => WorkspaceId | undefined
  /**
   * Whether the ownership authority is available. When it is not, the policy
   * binds nothing, so existing and new bindings alike refuse work.
   */
  readonly available?: () => boolean
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
    'agentPresets/list',
    'permissionPresets/catalog',
    'session/modelCatalog',
  ],
}

/**
 * Calls on one Session the staff user owns. `session/list` and `workspace/follow` are here on purpose: those
 * methods filter each item through `allows({ kind: 'session', id })`, which tests the current action against
 * the session binding's role, so the role must list it for the Session to appear in the list or the Workspace view.
 * `session/create` is here because a create that names an own blank Session to reuse resolves it as a session resource.
 */
const STAFF_OWNED_SESSION_ROLE: RemoteAccessRole<'session'> = {
  name: 'staff:owned-session',
  resource: 'session',
  actions: [
    'commands/list',
    'goals/get',
    'skills/list',
    'session/list',
    'workspace/follow',
    'session/create',
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

/**
 * Calls on the shared staff Workspace. `workspace/follow` admits it in the list; `session/create` admits a
 * create that names it. No other Workspace is bound, so it is refused for staff.
 */
const STAFF_WORKSPACE_ROLE: RemoteAccessRole<'workspace'> = {
  name: 'staff:workspace',
  resource: 'workspace',
  actions: [
    'workspace/follow',
    'session/create',
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
  const { ownership, workspaceId } = options
  const available = options.available ?? (() => true)
  return {
    bindings(staff) {
      // A latched ownership-authority failure withdraws every binding, so a
      // queued or new request cannot act on cached authorization.
      if (!available()) return []
      const ownedBy: RemoteAccessCondition<'session'> = ({ resource }) =>
        available() && ownership.ownerOf(resource.id) === staff.userId ? ALLOW : NOT_OWNED
      return [
        { role: STAFF_GLOBAL_ROLE, resource: { kind: 'global' }, condition: () => available() ? ALLOW : NOT_OWNED },
        ...workspaceBindings(workspaceId(), available),
        ...ownership.sessionsOf(staff.userId).map(sessionId => ({
          role: STAFF_OWNED_SESSION_ROLE,
          resource: { kind: 'session' as const, id: sessionId },
          condition: ownedBy,
        })),
      ]
    },
  }
}

/** Bind the shared Workspace only while it exists and the authority is available. */
function workspaceBindings(
  sharedWorkspace: WorkspaceId | undefined,
  available: () => boolean,
): RemoteAccessBinding[] {
  if (sharedWorkspace === undefined) return []
  return [{
    role: STAFF_WORKSPACE_ROLE,
    resource: { kind: 'workspace', id: sharedWorkspace },
    condition: () => available() ? ALLOW : NOT_OWNED,
  }]
}
