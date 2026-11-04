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
import type { SessionOwnerIndex } from './owner-index.ts'

/** Agent preset every staff Session runs; declared by the web bundle's `presets/staff.patch.yml`. */
export const STAFF_AGENT_PRESET = 'staff'

/**
 * Admit staff create requests and record the owner of each Session a staff caller creates.
 *
 * Only `agentPreset` survives admission for a staff caller, and it is overwritten with
 * {@link STAFF_AGENT_PRESET}, so the request type's `sessionId`, `cwd`, and `workspaceId` fields are refused.
 * @param ctx - Context whose `api-session/create-request` and `api-session/created` events are admitted.
 * @param options - the owner index that records each staff Session.
 */
export function admitStaffCreates(ctx: Context, options: { readonly owners: SessionOwnerIndex }): void {
  const { owners } = options
  ctx.on('api-session/create-request', async (call, next) => {
    const principal = call.principal
    if (principal?.kind !== 'staff') return next()
    for (const [field, value] of Object.entries(call.request)) {
      if (field !== 'agentPreset' && value !== undefined) {
        throw new RemoteError('gateway/bad-request', `session.create does not accept "${field}" for staff`, {})
      }
    }
    call.request = { agentPreset: STAFF_AGENT_PRESET }
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
