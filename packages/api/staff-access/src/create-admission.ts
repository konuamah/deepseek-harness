/**
 * Staff admission of Session creation: each staff create runs the `staff` Agent preset with no tools, only
 * reuses blank Sessions the same user owns, and is recorded to that user before the create returns.
 *
 * @module @deepseek-ai/dsh-api-staff-access/src/create-admission
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remote-access'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { SessionOwnerIndex } from './owner-index.ts'

/** Agent preset every staff Session runs; declared by the web bundle's `presets/staff.patch.yml`. */
export const STAFF_AGENT_PRESET = 'staff'

/**
 * Admit staff create requests and record the owner of each Session a staff caller creates.
 *
 * A staff caller keeps only `agentPreset`, overwritten with {@link STAFF_AGENT_PRESET}, and `workspaceId`, which
 * must equal the shared staff Workspace or be omitted; the shared id is then filled in. `sessionId` is kept only
 * when the caller owns that Session. `cwd` and every other field are refused. A create before the shared Workspace
 * is registered is refused.
 * @param ctx - Context whose `api-session/create-request` and `api-session/created` events are admitted.
 * @param options - the owner index that records each staff Session, and the shared Workspace id once known.
 */
export function admitStaffCreates(ctx: Context, options: {
  readonly owners: SessionOwnerIndex
  readonly workspaceId: () => WorkspaceId | undefined
}): void {
  const { owners } = options
  ctx.on('api-session/create-request', async (call, next) => {
    const principal = call.principal
    if (principal?.kind !== 'staff') return next()
    const sharedWorkspace = options.workspaceId()
    if (sharedWorkspace === undefined) {
      throw new RemoteError('gateway/bad-request', 'the staff Workspace is not available yet', {})
    }
    // A named Session is accepted only when the caller owns it: the client names its own blank Session to reuse.
    const named = call.request.sessionId
    if (named !== undefined && owners.ownerOf(named) !== principal.userId) {
      throw new RemoteError('gateway/bad-request', 'session.create does not accept "sessionId" for staff', {})
    }
    for (const [field, value] of Object.entries(call.request)) {
      if (value === undefined || field === 'agentPreset') continue
      if (field === 'workspaceId' && value === sharedWorkspace) continue
      if (field === 'sessionId' && named !== undefined) continue
      throw new RemoteError('gateway/bad-request', `session.create does not accept "${field}" for staff`, {})
    }
    call.request = {
      agentPreset: STAFF_AGENT_PRESET,
      workspaceId: sharedWorkspace,
      ...named === undefined ? {} : { sessionId: named },
    }
    const reusable = call.reusable
    call.reusable = sessionId => reusable(sessionId) && owners.ownerOf(sessionId) === principal.userId
    return next()
  })
  ctx.on('api-session/created', (sessionId, principal) => {
    if (principal?.kind !== 'staff') return
    owners.record(sessionId, principal.userId)
    ctx.remoteAccess.invalidate(principal)
  })
}
