import { createHash } from 'node:crypto'
import type { StaffAuthenticator, StaffDecision } from './types.ts'

/** Options for the Django session authenticator. */
export interface DjangoStaffAuthenticatorOptions {
  /** Django origin, without a trailing path. */
  readonly baseUrl: string
  /** Session cookie name; other cookies are never forwarded. Defaults to `sessionid`. */
  readonly cookieName?: string
  /** Roles allowed to pass; any other role is denied. */
  readonly roles: readonly string[]
  /** Lifetime of allow decisions. Defaults to 60 000 ms. */
  readonly ttlMs?: number
  /** Lifetime of every deny decision except no-cookie (unavailable, rejected, wrong-role, two-factor). Defaults to 5 000 ms. */
  readonly failureTtlMs?: number
  /** Upstream request timeout. Defaults to 3 000 ms. */
  readonly timeoutMs?: number
  readonly fetch?: typeof fetch
  readonly now?: () => number
}

/** Staff authenticator that also drops cached allow decisions for one user. */
export interface DjangoStaffAuthenticator extends StaffAuthenticator {
  /** Drops cached allow decisions for `userId`; a fetch already in flight is not cancelled. */
  invalidateUser(userId: number): void
}

interface CacheEntry { readonly decision: StaffDecision; readonly expiresAt: number }
interface Outcome { readonly decision: StaffDecision; readonly lifetimeMs: number }

const MAX_ENTRIES = 1000

/**
 * Builds a Django-backed staff authenticator with a bounded decision cache.
 * @param options - Django origin, roles, and timing options.
 * @returns The authenticator; it never throws from `authenticate`.
 */
export function createDjangoStaffAuthenticator(options: DjangoStaffAuthenticatorOptions): DjangoStaffAuthenticator {
  const cookieName = options.cookieName ?? 'sessionid'
  const ttlMs = options.ttlMs ?? 60_000
  const failureTtlMs = options.failureTtlMs ?? 5_000
  const timeoutMs = options.timeoutMs ?? 3_000
  const doFetch = options.fetch ?? ((input: string, init: RequestInit) => globalThis.fetch(input, init))
  const now = options.now ?? Date.now
  const cache = new Map<string, CacheEntry>()
  const inFlight = new Map<string, Promise<StaffDecision>>()

  function store(key: string, decision: StaffDecision, lifetimeMs: number): void {
    cache.delete(key)
    if (cache.size >= MAX_ENTRIES) {
      for (const oldest of cache.keys()) {
        cache.delete(oldest)
        break
      }
    }
    cache.set(key, { decision, expiresAt: now() + lifetimeMs })
  }

  function deny(reason: 'rejected' | 'unavailable' | 'wrong-role' | 'two-factor', lifetimeMs = failureTtlMs): Outcome {
    return { decision: { kind: 'deny', reason }, lifetimeMs }
  }

  async function fetchDecision(cookieValue: string): Promise<Outcome> {
    let response: Response
    try {
      response = await doFetch(`${options.baseUrl}/api/v1/users/me/`, {
        headers: { Cookie: `${cookieName}=${cookieValue}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      })
    } catch {
      return deny('unavailable', failureTtlMs)
    }
    if (response.status === 401 || response.status === 403) return deny('rejected')
    if (response.status !== 200) return deny('unavailable', failureTtlMs)
    let body: unknown
    try {
      body = await response.json()
    } catch {
      return deny('unavailable', failureTtlMs)
    }
    if (!isMeBody(body)) return deny('unavailable', failureTtlMs)
    if (body.two_factor_required && !body.two_factor_satisfied) return deny('two-factor')
    if (!options.roles.includes(body.role)) return deny('wrong-role')
    return { decision: { kind: 'allow', identity: { userId: body.id, role: body.role } }, lifetimeMs: ttlMs }
  }

  function resolve(key: string, cookieValue: string): Promise<StaffDecision> {
    const pending = inFlight.get(key)
    if (pending) return pending
    const promise = fetchDecision(cookieValue)
      .then(({ decision, lifetimeMs }) => {
        store(key, decision, lifetimeMs)
        return decision
      })
      .finally(() => inFlight.delete(key))
    inFlight.set(key, promise)
    return promise
  }

  return {
    async authenticate(headers) {
      const cookieValue = findCookie(headers.cookie, cookieName)
      if (!cookieValue) return { kind: 'deny', reason: 'no-cookie' }
      const key = createHash('sha256').update(cookieValue).digest('hex')
      const cached = cache.get(key)
      if (cached && now() < cached.expiresAt) return cached.decision
      cache.delete(key)
      return resolve(key, cookieValue)
    },
    invalidateUser(userId) {
      for (const [key, entry] of cache) {
        if (entry.decision.kind === 'allow' && entry.decision.identity.userId === userId) cache.delete(key)
      }
    },
  }
}

function findCookie(header: string | string[] | undefined, name: string): string | undefined {
  const raw = Array.isArray(header) ? header.join('; ') : header
  if (!raw) return undefined
  for (const piece of raw.split(';')) {
    const trimmed = piece.trim()
    const eq = trimmed.indexOf('=')
    if (eq < 0) continue
    if (trimmed.slice(0, eq) === name) return trimmed.slice(eq + 1) || undefined
  }
  return undefined
}

interface MeBody {
  readonly id: number
  readonly role: string
  readonly two_factor_required: boolean
  readonly two_factor_satisfied: boolean
}

function isMeBody(value: unknown): value is MeBody {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return 'id' in value && Number.isInteger(value.id)
    && 'role' in value && typeof value.role === 'string'
    && 'two_factor_required' in value && typeof value.two_factor_required === 'boolean'
    && 'two_factor_satisfied' in value && typeof value.two_factor_satisfied === 'boolean'
}
