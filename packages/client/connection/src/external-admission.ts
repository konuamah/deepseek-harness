/** Provider contract for non-owner Peers admitted from request headers. */

import type {} from '@deepseek-ai/cordis'
import type { Principal } from '@deepseek-ai/dsh-typert-protocol'

/**
 * Result of one external admission: the Peer to speak for, or a refusal.
 * `key` identifies one user (for example `staff:42`); Connection shares one
 * Peer per key. `principal` is the protocol principal that Peer speaks for.
 */
export type ExternalAdmission =
  | { readonly kind: 'allow'; readonly key: string; readonly principal: Principal }
  | { readonly kind: 'deny' }

/**
 * Admits non-owner Peers from request headers. A provider may throw; Connection
 * treats a throw as a denial. Connection calls it only after the owner path
 * refused a request that passed the Host/Origin fence.
 */
export interface ExternalPeerAdmission {
  /**
   * Decide one request.
   * @param headers - request headers from the Fetch or node:http representation.
   * @returns the admitted key and principal, or a denial.
   */
  admit(headers: Readonly<Record<string, string | string[] | undefined>>): Promise<ExternalAdmission>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Optional provider for non-owner Peers; absent means owner-only admission. */
    externalPeerAdmission: ExternalPeerAdmission
  }
}
