/** Staff identity taken from an authenticated Django session. */
export interface StaffIdentity { readonly userId: number; readonly role: string }

/** Outcome of authenticating one Remote request. Deny reasons are stable strings. */
export type StaffDecision =
  | { readonly kind: 'allow'; readonly identity: StaffIdentity }
  | { readonly kind: 'deny'; readonly reason: 'no-cookie' | 'rejected' | 'wrong-role' | 'two-factor' | 'unavailable' }

/** Authenticates the request headers of one Remote connection. */
export interface StaffAuthenticator {
  /** Never throws; every failure resolves to a deny decision. */
  authenticate(headers: Readonly<Record<string, string | string[] | undefined>>): Promise<StaffDecision>
}
