/**
 * Staff access plugin: opens the owner index, provides it as `staffSessions`, and registers the staff
 * Remote access policy. Mounting it changes access only for staff callers; the owner Host is unaffected.
 *
 * @module @deepseek-ai/dsh-api-staff-access/src/plugin
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remote-access'
import { createSessionOwnerIndex, type SessionOwnerIndex } from './owner-index.ts'
import { createStaffPolicy } from './policy.ts'

export const name = 'staff-access'

/** Configuration of the staff access plugin. */
export interface Config {
  /** Owner-local JSON file recording which staff user owns each Session. */
  readonly ownersFile: string
}

/** The service this plugin provides under `staffSessions`. */
export interface StaffSessionsService {
  /** Owner index of the Sessions staff users own. */
  readonly owners: SessionOwnerIndex
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Staff ownership of Sessions, provided by the staff access plugin. */
    staffSessions: StaffSessionsService
  }
}

/**
 * Mount the staff access plugin.
 * @param ctx - Host Context that receives the service and the policy.
 * @param config - Plugin configuration; `ownersFile` is required.
 * @throws Error when `ownersFile` is missing or empty, or when the owner file does not load.
 */
export function apply(ctx: Context, config: Config): void {
  if (typeof config.ownersFile !== 'string' || config.ownersFile === '') {
    throw new Error('staff-access: ownersFile is required')
  }
  const owners = createSessionOwnerIndex({ file: config.ownersFile })
  ctx.provide('staffSessions', { owners })
  ctx.inject(['remoteAccess'], (scope) => {
    scope.remoteAccess.registerPolicy('staff', createStaffPolicy({ owners }))
  })
}
