/**
 * Mints Django AI read tokens on behalf of one staff user and caches them per user. The token is minted with
 * that user's own held session cookie, so it can never be issued for, or used by, another user. Tokens,
 * cookies, and CSRF values never appear in an error message: every failure is `staff-access: sign in again`.
 *
 * @module @deepseek-ai/dsh-api-staff-access/src/ai-token
 */

/** Most users whose token is cached at once; the oldest is forgotten first. */
const MAX_CACHED_USERS = 1000
const SIGN_IN_AGAIN = 'staff-access: sign in again'

/** Options for {@link createAiTokenProvider}. */
export interface AiTokenProviderOptions {
  /** Django origin, such as `https://django.example`. */
  readonly djangoBaseUrl: string
  /** Django session cookie name. Defaults to `sessionid`. */
  readonly cookieName?: string
  readonly fetch?: typeof fetch
  readonly now?: () => number
  /** A cached token is reused only while it stays valid for at least this long. Defaults to 60 000 ms. */
  readonly refreshMarginMs?: number
  /** Timeout of each Django request. Defaults to 3 000 ms. */
  readonly timeoutMs?: number
  /** The session cookie value held for a user, or undefined when none is held. */
  readonly cookieFor: (userId: number) => string | undefined
  /** The staff user who owns a Session, or the owner of its nearest owned ancestor. */
  readonly ownerOf: (sessionId: string) => number | undefined
}

/** Per-user AI token source. */
export interface AiTokenProvider {
  /**
   * A read token for the user who owns the Session.
   * @param sessionId - Session the tool call belongs to.
   * @returns the bearer token.
   * @throws Error `staff-access: sign in again` when the Session has no owner, no cookie is held, or Django fails.
   */
  tokenFor(sessionId: string): Promise<string>
  /**
   * Forget a user's cached token; a mint in flight for that user is discarded when it settles.
   * @param userId - Django user id.
   */
  drop(userId: number): void
}

interface Cached { readonly token: string; readonly expiresAt: number }
interface Inflight { readonly promise: Promise<string> }

/**
 * Build the AI token provider.
 * @param options - Django origin, the cookie and owner lookups, and optional timing.
 * @returns the provider.
 */
export function createAiTokenProvider(options: AiTokenProviderOptions): AiTokenProvider {
  const { djangoBaseUrl, cookieFor, ownerOf } = options
  const cookieName = options.cookieName ?? 'sessionid'
  const doFetch = options.fetch ?? ((input: string, init: RequestInit) => globalThis.fetch(input, init))
  const now = options.now ?? Date.now
  const refreshMarginMs = options.refreshMarginMs ?? 60_000
  const timeoutMs = options.timeoutMs ?? 3_000
  const cache = new Map<number, Cached>()
  const inflight = new Map<number, Inflight>()

  const fail = (): Error => new Error(SIGN_IN_AGAIN)

  /** Django's CSRF pair: the cookie it set and the token from the body. */
  async function csrf(cookie: string): Promise<{ cookieValue: string; header: string }> {
    const response = await doFetch(`${djangoBaseUrl}/api/v1/users/csrf-token/`, {
      method: 'GET',
      headers: { Cookie: `${cookieName}=${cookie}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    })
    if (response.status !== 200) throw fail()
    const body: unknown = await response.json()
    if (typeof body !== 'object' || body === null || !('csrfToken' in body)
      || typeof body.csrfToken !== 'string' || body.csrfToken === '') throw fail()
    const set = response.headers.getSetCookie().find(line => line.startsWith('csrftoken='))
    const cookieValue = set === undefined ? body.csrfToken : set.slice('csrftoken='.length).split(';')[0] ?? ''
    if (cookieValue === '') throw fail()
    return { cookieValue, header: body.csrfToken }
  }

  async function mint(cookie: string): Promise<{ token: string; ttlMs: number }> {
    try {
      const { cookieValue, header } = await csrf(cookie)
      const response = await doFetch(`${djangoBaseUrl}/api/v1/ai/token/`, {
        method: 'POST',
        headers: {
          Cookie: `${cookieName}=${cookie}; csrftoken=${cookieValue}`,
          'X-CSRFToken': header,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Origin: djangoBaseUrl,
          Referer: djangoBaseUrl,
        },
        body: JSON.stringify({ kind: 'read' }),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
      })
      if (response.status !== 200) throw fail()
      const body: unknown = await response.json()
      if (typeof body !== 'object' || body === null || !('token' in body) || !('expires_in' in body)
        || typeof body.token !== 'string' || body.token === ''
        || !Number.isSafeInteger(body.expires_in) || (body.expires_in as number) <= 0) throw fail()
      return { token: body.token, ttlMs: (body.expires_in as number) * 1000 }
    } catch {
      throw fail()
    }
  }

  function store(userId: number, entry: Cached): void {
    cache.delete(userId)
    if (cache.size >= MAX_CACHED_USERS) {
      for (const oldest of cache.keys()) {
        cache.delete(oldest)
        break
      }
    }
    cache.set(userId, entry)
  }

  return {
    async tokenFor(sessionId) {
      const owner = ownerOf(sessionId)
      const cookie = owner === undefined ? undefined : cookieFor(owner)
      if (owner === undefined || cookie === undefined) throw fail()
      const cached = cache.get(owner)
      if (cached !== undefined && cached.expiresAt - now() >= refreshMarginMs) return cached.token
      const pending = inflight.get(owner)
      if (pending !== undefined) return pending.promise
      const entry: Inflight = {
        promise: mint(cookie).then(({ token, ttlMs }) => {
          // A drop (revoke) while minting removed this entry: discard the result for every waiter.
          if (inflight.get(owner) !== entry) throw fail()
          store(owner, { token, expiresAt: now() + ttlMs })
          return token
        }).finally(() => {
          if (inflight.get(owner) === entry) inflight.delete(owner)
        }),
      }
      inflight.set(owner, entry)
      return entry.promise
    },
    drop(userId) {
      cache.delete(userId)
      inflight.delete(userId)
    },
  }
}
