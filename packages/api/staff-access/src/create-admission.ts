/**
 * Staff admission of Session creation: each staff create runs the `staff` Agent preset with no tools, only
 * reuses blank Sessions the same user owns, and records or verifies the owner before the create returns.
 *
 * File ownership records the owner after durable creation. Database ownership reserves the exact new Session
 * id before creation, so the provider inserts the owner in the same transaction as the Session, then verifies
 * the committed row before the create is announced.
 *
 * @module @deepseek-ai/dsh-api-staff-access/src/create-admission
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remote-access'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { StaffOwnershipReader } from './owner-index.ts'

/** Agent preset every staff Session runs; declared by the web bundle's `presets/staff.patch.yml`. */
export const STAFF_AGENT_PRESET = 'staff'

/** How a composition writes or verifies the owner of a newly created Session. */
export interface StaffCreateOwnership {
  /** File mode: record the owner after durable creation. */
  readonly record?: (sessionId: SessionId, userId: number) => void
  /** Database mode: reserve the exact id before the storage create. */
  readonly reserve?: (sessionId: SessionId, userId: number) => () => Promise<void>
  /** Database mode: verify the committed ownership before the create is announced. */
  readonly verify?: (sessionId: SessionId, userId: number) => Promise<boolean>
  /** Whether the ownership authority is currently available. */
  readonly available?: () => boolean
}

/** Options for {@link admitStaffCreates}. */
export interface StaffCreateAdmissionOptions {
  /** Ownership reads for reuse and creation filters. */
  readonly ownership: StaffOwnershipReader
  /** Composition-specific owner write path. */
  readonly create: StaffCreateOwnership
  /** The shared Workspace id once known. */
  readonly workspaceId: () => WorkspaceId | undefined
}

/** Refusal text shared by create and tool admission while the database is down. */
const UNAVAILABLE = 'chat storage is unavailable; restart the Harness'

/** Refuse any request field outside the staff create contract. */
function assertAllowedFields(
  request: object,
  sharedWorkspace: WorkspaceId,
  named: SessionId | undefined,
): void {
  for (const [field, value] of Object.entries(request)) {
    if (value === undefined || field === 'agentPreset') continue
    if (field === 'workspaceId' && value === sharedWorkspace) continue
    if (field === 'sessionId' && named !== undefined) continue
    throw new RemoteError('gateway/bad-request', `session.create does not accept "${field}" for staff`, {})
  }
}

/**
 * Admit staff create requests and record or verify the owner of each Session a staff caller creates.
 *
 * A staff caller keeps only `agentPreset`, overwritten with {@link STAFF_AGENT_PRESET}, and `workspaceId`, which
 * must equal the shared staff Workspace or be omitted; the shared id is then filled in. `sessionId` is kept only
 * when the caller owns that Session. `cwd` and every other field are refused. A create before the shared Workspace
 * is registered is refused.
 * @param ctx - Context whose `api-session/create-request` and `api-session/created` events are admitted.
 * @param options - the ownership reads, owner write path, and shared Workspace id once known.
 */
export function admitStaffCreates(ctx: Context, options: StaffCreateAdmissionOptions): void {
  const { ownership, create } = options
  const available = create.available ?? (() => true)
  ctx.on('api-session/create-request', async (call, next) => {
    const principal = call.principal
    if (principal?.kind !== 'staff') return next()
    if (!available()) throw new RemoteError('gateway/internal', UNAVAILABLE, {})
    const sharedWorkspace = options.workspaceId()
    if (sharedWorkspace === undefined) {
      throw new RemoteError('gateway/bad-request', 'the staff Workspace is not available yet', {})
    }
    // A named Session is accepted only when the caller owns it: the client names its own blank Session to reuse.
    const named = call.request.sessionId
    if (named !== undefined && ownership.ownerOf(named) !== principal.userId) {
      throw new RemoteError('gateway/bad-request', 'session.create does not accept "sessionId" for staff', {})
    }
    assertAllowedFields(call.request, sharedWorkspace, named)
    call.request = {
      agentPreset: STAFF_AGENT_PRESET,
      workspaceId: sharedWorkspace,
      ...named === undefined ? {} : { sessionId: named },
    }
    const reserve = create.reserve
    if (reserve !== undefined) {
      const userId = principal.userId
      call.reserve = sessionId => Promise.resolve(reserve(sessionId, userId))
    }
    const reusable = call.reusable
    call.reusable = sessionId => reusable(sessionId) && ownership.ownerOf(sessionId) === principal.userId
    return next()
  })
  ctx.on('api-session/created', async (sessionId, principal) => {
    if (principal?.kind !== 'staff') return
    if (create.verify !== undefined) {
      if (!await create.verify(sessionId, principal.userId)) {
        throw new Error('staff-access: the created Session has no committed owner')
      }
    } else {
      create.record?.(sessionId, principal.userId)
    }
    ctx.remoteAccess.invalidate(principal)
  })
}
