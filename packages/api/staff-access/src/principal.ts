/**
 * The Remote caller identity of one staff user, as the Django session identified it.
 *
 * The value carries only the user id and the role, so the policy and the owner index can name the caller
 * without holding the session cookie, the email, or the name. Every field is copied one by one, so an
 * identity that also carries those fields contributes only the two above.
 *
 * @module @deepseek-ai/dsh-api-staff-access/src/principal
 */

import type { StaffIdentity } from './types.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    /** One authenticated staff user, identified by the Django user id and role. */
    staff: StaffPrincipal
  }
}

/** One staff caller on the Remote gateway. */
export interface StaffPrincipal {
  readonly kind: 'staff'
  /** Django user id; the owner index keys Session ownership by it. */
  readonly userId: number
  /** Role the Django session was admitted with. */
  readonly role: string
}

/**
 * Build the principal one staff caller's calls speak for.
 * @param identity - Identity the staff authenticator admitted.
 * @returns The principal carrying only the user id and role.
 */
export function staffPrincipal(identity: StaffIdentity): StaffPrincipal {
  return { kind: 'staff', userId: identity.userId, role: identity.role }
}
