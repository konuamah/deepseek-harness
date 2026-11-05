import { describe, expect, it, vi } from 'vitest'
import { createAiTokenProvider } from '../src/ai-token.ts'

const BASE = 'https://django.test'
const SIGN_IN = 'staff-access: sign in again'
const COOKIES = new Map([[1, 'COOKIE-A-secret'], [2, 'COOKIE-B-secret']])
const OWNERS = new Map([['sa', 1], ['sa-child', 1], ['sb', 2]])
const SECRETS = ['COOKIE-A-secret', 'COOKIE-B-secret', 'CSRF-1', 'CSRF-2', 'CSRFC-1', 'CSRFC-2', 'TOK-1', 'TOK-2']

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body?: string | undefined
  redirect?: string | undefined
  signal?: unknown
}

/** Fake Django: the cookie names the user; every request is recorded. */
type Answer = () => Response | Promise<Response>

function fakeDjango(overrides: { csrf?: Answer; token?: Answer } = {}, expiresIn = 900) {
  const calls: Call[] = []
  let minted = 0
  const userOf = (cookie: string | undefined): number | undefined => {
    for (const [id, value] of COOKIES) if (cookie?.includes(`sessionid=${value}`)) return id
    return undefined
  }
  const doFetch = vi.fn(async (target: string | URL | Request, init: RequestInit = {}) => {
    const input = typeof target === 'string' ? target : target instanceof URL ? target.href : target.url
    const headers = Object.fromEntries(Object.entries(init.headers as Record<string, string>))
    calls.push({
      url: input, method: String(init.method), headers, body: init.body as string | undefined,
      redirect: init.redirect, signal: init.signal,
    })
    const user = userOf(headers.Cookie)
    if (user === undefined) return new Response('{}', { status: 403 })
    if (input.endsWith('/api/v1/users/csrf-token/')) {
      if (overrides.csrf) return overrides.csrf()
      const headers = { 'set-cookie': `csrftoken=CSRFC-${user}; Path=/; SameSite=Lax` }
      return new Response(JSON.stringify({ csrfToken: `CSRF-${user}` }), { headers })
    }
    if (overrides.token) return overrides.token()
    minted++
    return new Response(JSON.stringify({ token: `TOK-${user}-${minted}`, expires_in: expiresIn }), { status: 200 })
  })
  return { doFetch, calls, minted: () => minted }
}

function provider(django: ReturnType<typeof fakeDjango>, extra: { now?: () => number; cookies?: Map<number, string> } = {}) {
  const cookies = extra.cookies ?? COOKIES
  return createAiTokenProvider({
    djangoBaseUrl: BASE,
    fetch: django.doFetch,
    ...(extra.now === undefined ? {} : { now: extra.now }),
    cookieFor: id => cookies.get(id),
    ownerOf: sid => OWNERS.get(sid),
  })
}

const posts = (django: ReturnType<typeof fakeDjango>) => django.calls.filter(c => c.method === 'POST')

describe('ai token provider', () => {
  it('mints with the exact cookie, CSRF, origin, referer, body and redirect settings', async () => {
    const django = fakeDjango()
    await expect(provider(django).tokenFor('sa')).resolves.toBe('TOK-1-1')
    expect(django.calls).toHaveLength(2)
    const [get, post] = django.calls
    if (get === undefined || post === undefined) throw new Error('expected two Django calls')
    expect(get).toMatchObject({ url: `${BASE}/api/v1/users/csrf-token/`, method: 'GET', redirect: 'error' })
    expect(get.headers.Cookie).toBe('sessionid=COOKIE-A-secret')
    expect(get.signal).toBeInstanceOf(AbortSignal)
    expect(post).toMatchObject({ url: `${BASE}/api/v1/ai/token/`, method: 'POST', redirect: 'error', body: '{"kind":"read"}' })
    expect(post.headers).toMatchObject({
      Cookie: 'sessionid=COOKIE-A-secret; csrftoken=CSRFC-1',
      'X-CSRFToken': 'CSRF-1',
      'Content-Type': 'application/json',
      Origin: BASE,
      Referer: BASE,
    })
    expect(post.signal).toBeInstanceOf(AbortSignal)
  })

  it('mints for each user with that user cookie only, concurrently', async () => {
    const django = fakeDjango()
    const p = provider(django)
    const [a, b, child] = await Promise.all([p.tokenFor('sa'), p.tokenFor('sb'), p.tokenFor('sa-child')])
    expect(a).toMatch(/^TOK-1-/)
    expect(b).toMatch(/^TOK-2-/)
    expect(child).toBe(a) // the child session resolves to its owner and shares that user's single flight
    for (const call of django.calls) {
      const cookie = call.headers.Cookie
      if (cookie === undefined) throw new Error('missing Cookie header')
      const own = cookie.includes('COOKIE-A-secret') ? 'A' : 'B'
      expect(cookie.includes(own === 'A' ? 'COOKIE-B' : 'COOKIE-A')).toBe(false)
      expect(JSON.stringify(call.headers).includes(own === 'A' ? 'CSRF-2' : 'CSRF-1')).toBe(false)
    }
    expect(posts(django)).toHaveLength(2)
  })

  it('fails with no Django call when the session has no owner or no cookie is held', async () => {
    const django = fakeDjango()
    await expect(provider(django).tokenFor('unknown')).rejects.toThrow(SIGN_IN)
    await expect(provider(django, { cookies: new Map() }).tokenFor('sa')).rejects.toThrow(SIGN_IN)
    expect(django.doFetch).not.toHaveBeenCalled()
  })

  it('reuses a cached token within the margin and refreshes once near expiry under concurrency', async () => {
    const django = fakeDjango({}, 300)
    let clock = 0
    const p = provider(django, { now: () => clock })
    const first = await p.tokenFor('sa')
    clock = 200_000
    expect(await p.tokenFor('sa')).toBe(first)
    expect(posts(django)).toHaveLength(1)
    clock = 245_000 // 55 s left, under the 60 s margin
    const tokens = await Promise.all(Array.from({ length: 20 }, () => p.tokenFor('sa')))
    expect(new Set(tokens).size).toBe(1)
    expect(tokens[0]).not.toBe(first)
    expect(posts(django)).toHaveLength(2)
  })

  it.each<[string, { csrf?: Answer; token?: Answer }]>([
    ['csrf 500', { csrf: () => new Response('{}', { status: 500 }) }],
    ['csrf malformed', { csrf: () => new Response('{"csrfToken":5}') }],
    ['csrf network error', { csrf: () => { throw new Error('boom CSRF-1 COOKIE-A-secret') } }],
    ['token 403', { token: () => new Response('{"detail":"TOK-1 COOKIE-A-secret"}', { status: 403 }) }],
    ['token network error', { token: () => { throw new Error('boom TOK-1') } }],
    ['token malformed json', { token: () => new Response('not json TOK-1') }],
    ['token empty', { token: () => new Response('{"token":"","expires_in":900}') }],
    ['token bad expiry', { token: () => new Response('{"token":"TOK-1","expires_in":0}') }],
    ['token string expiry', { token: () => new Response('{"token":"TOK-1","expires_in":"900"}') }],
  ])('fails closed without leaking values: %s', async (_label, overrides) => {
    const django = fakeDjango(overrides)
    const logged = vi.spyOn(console, 'error')
    const p = provider(django)
    const error = await p.tokenFor('sa').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe(SIGN_IN)
    expect((error as Error).cause).toBeUndefined()
    for (const secret of SECRETS) expect(JSON.stringify(error, Object.getOwnPropertyNames(error as object))).not.toContain(secret)
    expect(logged).not.toHaveBeenCalled()
    logged.mockRestore()
    // nothing cached: the next call tries Django again
    const before = django.doFetch.mock.calls.length
    await p.tokenFor('sa').catch(() => undefined)
    expect(django.doFetch.mock.calls.length).toBeGreaterThan(before)
  })

  it('aborts a hung Django request at the timeout and caches nothing', async () => {
    const hung = vi.fn((_target: string | URL | Request, init: RequestInit = {}) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => { reject(new Error('aborted COOKIE-A-secret')) })
    }))
    const p = createAiTokenProvider({
      djangoBaseUrl: BASE, fetch: hung, timeoutMs: 20,
      cookieFor: id => COOKIES.get(id), ownerOf: sid => OWNERS.get(sid),
    })
    await expect(p.tokenFor('sa')).rejects.toThrow(SIGN_IN)
    await expect(p.tokenFor('sa')).rejects.toThrow(SIGN_IN)
    expect(hung).toHaveBeenCalledTimes(2)
  })

  it('drop forgets the cached token and discards a mint in flight', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const django = fakeDjango({ token: async () => { await gate; return new Response('{"token":"TOK-1-late","expires_in":900}') } })
    const p = provider(django)
    const pending = p.tokenFor('sa').catch((e: unknown) => e)
    await vi.waitFor(() => { expect(posts(django)).toHaveLength(1) })
    p.drop(1)
    release()
    expect(((await pending) as Error).message).toBe(SIGN_IN)
    // the late result was not cached: the next call mints again
    const fresh = fakeDjango()
    expect(await provider(fresh).tokenFor('sa')).toBe('TOK-1-1')
    await p.tokenFor('sa').catch(() => undefined)
    expect(posts(django)).toHaveLength(2)
  })

  it('drop removes a cached token', async () => {
    const django = fakeDjango()
    const p = provider(django)
    await p.tokenFor('sa')
    p.drop(1)
    expect(await p.tokenFor('sa')).toBe('TOK-1-2')
  })
})
