import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDjangoStaffAuthenticator, type DjangoStaffAuthenticatorOptions } from '../src/index.ts'

const BASE = 'https://django.test'
const ME = { id: 7, role: 'ADMISSIONS_OFFICER', two_factor_required: false, two_factor_satisfied: false }
const ROLES = ['ADMISSIONS_OFFICER', 'ADMISSIONS_MANAGER']

let clock = 0

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

function session(value: string): Record<string, string> {
  return { cookie: `sessionid=${value}` }
}

function build(fetchFn: typeof fetch, extra: Partial<DjangoStaffAuthenticatorOptions> = {}) {
  return createDjangoStaffAuthenticator({ baseUrl: BASE, roles: ROLES, fetch: fetchFn, now: () => clock, ...extra })
}

/** Upstream that answers every call with the given body and status. */
function upstream(body: unknown = ME, status = 200) {
  return vi.fn<typeof fetch>(async () => reply(body, status))
}

afterEach(() => {
  clock = 0
  vi.unstubAllGlobals()
})

describe('createDjangoStaffAuthenticator', () => {
  it('allows an ADMISSIONS_OFFICER session', async () => {
    const auth = build(upstream())
    expect(await auth.authenticate(session('abc'))).toEqual({
      kind: 'allow',
      identity: { userId: 7, role: 'ADMISSIONS_OFFICER' },
    })
  })

  it('allows an ADMISSIONS_MANAGER session', async () => {
    const auth = build(upstream({ ...ME, id: 8, role: 'ADMISSIONS_MANAGER' }))
    expect(await auth.authenticate(session('abc'))).toEqual({
      kind: 'allow',
      identity: { userId: 8, role: 'ADMISSIONS_MANAGER' },
    })
  })

  it('denies no-cookie without calling Django when the header is missing or has no session cookie', async () => {
    const fetchFn = upstream()
    const auth = build(fetchFn)
    expect(await auth.authenticate({})).toEqual({ kind: 'deny', reason: 'no-cookie' })
    expect(await auth.authenticate({ cookie: 'a=1; b=2' })).toEqual({ kind: 'deny', reason: 'no-cookie' })
    expect(await auth.authenticate({ cookie: 'sessionid=' })).toEqual({ kind: 'deny', reason: 'no-cookie' })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('ignores other cookies and forwards only the session cookie', async () => {
    const fetchFn = upstream()
    const auth = build(fetchFn)
    await auth.authenticate({ cookie: 'a=1; sessionid=abc; b=2' })
    expect(fetchFn).toHaveBeenCalledTimes(1)
    expect(fetchFn).toHaveBeenCalledWith(`${BASE}/api/v1/users/me/`, expect.objectContaining({
      headers: { Cookie: 'sessionid=abc', Accept: 'application/json' },
      redirect: 'error',
    }))
  })

  it('reads the session cookie from a repeated cookie header and skips pieces without a name', async () => {
    const fetchFn = upstream()
    const auth = build(fetchFn)
    await auth.authenticate({ cookie: ['flag', 'a=1', 'sessionid=abc=def'] })
    expect(fetchFn).toHaveBeenCalledWith(`${BASE}/api/v1/users/me/`, expect.objectContaining({
      headers: { Cookie: 'sessionid=abc=def', Accept: 'application/json' },
    }))
  })

  it('uses a custom cookie name', async () => {
    const fetchFn = upstream()
    const auth = build(fetchFn, { cookieName: 'staff' })
    expect(await auth.authenticate({ cookie: 'sessionid=abc; staff=xyz' })).toEqual({
      kind: 'allow',
      identity: { userId: 7, role: 'ADMISSIONS_OFFICER' },
    })
    expect(fetchFn).toHaveBeenCalledWith(`${BASE}/api/v1/users/me/`, expect.objectContaining({
      headers: { Cookie: 'staff=xyz', Accept: 'application/json' },
    }))
  })

  it.each([401, 403])('denies rejected on %i', async (status) => {
    const auth = build(upstream(null, status))
    expect(await auth.authenticate(session('abc'))).toEqual({ kind: 'deny', reason: 'rejected' })
  })

  it('denies unavailable on a 500', async () => {
    const auth = build(upstream(null, 500))
    expect(await auth.authenticate(session('abc'))).toEqual({ kind: 'deny', reason: 'unavailable' })
  })

  it('denies unavailable when fetch rejects', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => { throw new Error('network down') })
    const auth = build(fetchFn)
    expect(await auth.authenticate(session('abc'))).toEqual({ kind: 'deny', reason: 'unavailable' })
  })

  it('denies unavailable when a redirect is refused', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => { throw new TypeError('fetch failed') })
    const auth = build(fetchFn)
    expect(await auth.authenticate(session('abc'))).toEqual({ kind: 'deny', reason: 'unavailable' })
    expect(fetchFn).toHaveBeenCalledWith(`${BASE}/api/v1/users/me/`, expect.objectContaining({ redirect: 'error' }))
  })

  it('denies unavailable when the request times out', async () => {
    const fetchFn = vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(new Error('aborted')) })
    }))
    const auth = build(fetchFn, { timeoutMs: 10 })
    expect(await auth.authenticate(session('abc'))).toEqual({ kind: 'deny', reason: 'unavailable' })
  })

  it('denies unavailable on a malformed JSON body', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response('{not json', { status: 200 }))
    const auth = build(fetchFn)
    expect(await auth.authenticate(session('abc'))).toEqual({ kind: 'deny', reason: 'unavailable' })
  })

  it.each([
    ['a missing role', { id: 7, two_factor_required: false, two_factor_satisfied: false }],
    ['a missing two_factor_satisfied', { id: 7, role: 'ADMISSIONS_OFFICER', two_factor_required: false }],
    ['id as a string', { ...ME, id: '7' }],
    ['a non-integer id', { ...ME, id: 7.5 }],
    ['role as a number', { ...ME, role: 1 }],
    ['two_factor_required as a string', { ...ME, two_factor_required: 'no' }],
    ['a null body', null],
    ['an array body', [ME]],
    ['a string body', 'ADMISSIONS_OFFICER'],
  ])('denies unavailable on %s', async (_label, body) => {
    const auth = build(upstream(body))
    expect(await auth.authenticate(session('abc'))).toEqual({ kind: 'deny', reason: 'unavailable' })
  })

  it('denies two-factor when required but not satisfied', async () => {
    const auth = build(upstream({ ...ME, two_factor_required: true, two_factor_satisfied: false }))
    expect(await auth.authenticate(session('abc'))).toEqual({ kind: 'deny', reason: 'two-factor' })
  })

  it('allows when two-factor is required and satisfied', async () => {
    const auth = build(upstream({ ...ME, two_factor_required: true, two_factor_satisfied: true }))
    expect(await auth.authenticate(session('abc'))).toEqual({
      kind: 'allow',
      identity: { userId: 7, role: 'ADMISSIONS_OFFICER' },
    })
  })

  it('allows when two-factor is not required', async () => {
    const auth = build(upstream({ ...ME, two_factor_required: false, two_factor_satisfied: false }))
    expect((await auth.authenticate(session('abc'))).kind).toBe('allow')
  })

  it('denies wrong-role for a STUDENT', async () => {
    const auth = build(upstream({ ...ME, role: 'STUDENT' }))
    expect(await auth.authenticate(session('abc'))).toEqual({ kind: 'deny', reason: 'wrong-role' })
  })

  it('caches a two-factor denial for failureTtlMs, then allows once Django reports it satisfied', async () => {
    const fetchFn = upstream({ ...ME, two_factor_required: true, two_factor_satisfied: false })
    const auth = build(fetchFn)
    expect(await auth.authenticate(session('abc'))).toEqual({ kind: 'deny', reason: 'two-factor' })
    clock = 4_999
    expect(await auth.authenticate(session('abc'))).toEqual({ kind: 'deny', reason: 'two-factor' })
    expect(fetchFn).toHaveBeenCalledTimes(1)

    clock = 5_000
    fetchFn.mockResolvedValueOnce(reply({ ...ME, two_factor_required: true, two_factor_satisfied: true }))
    expect((await auth.authenticate(session('abc'))).kind).toBe('allow')
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('re-checks a rejected session after failureTtlMs', async () => {
    const fetchFn = upstream(null, 401)
    const auth = build(fetchFn)
    await auth.authenticate(session('abc'))
    clock = 4_999
    await auth.authenticate(session('abc'))
    expect(fetchFn).toHaveBeenCalledTimes(1)
    clock = 5_000
    await auth.authenticate(session('abc'))
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('re-checks a wrong-role session after failureTtlMs', async () => {
    const fetchFn = upstream({ ...ME, role: 'STUDENT' })
    const auth = build(fetchFn)
    await auth.authenticate(session('abc'))
    clock = 4_999
    await auth.authenticate(session('abc'))
    expect(fetchFn).toHaveBeenCalledTimes(1)
    clock = 5_000
    await auth.authenticate(session('abc'))
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('keeps an allow cached at failureTtlMs and re-checks it only after ttlMs', async () => {
    const fetchFn = upstream()
    const auth = build(fetchFn)
    await auth.authenticate(session('abc'))
    clock = 5_000
    expect((await auth.authenticate(session('abc'))).kind).toBe('allow')
    expect(fetchFn).toHaveBeenCalledTimes(1)
    clock = 60_000
    await auth.authenticate(session('abc'))
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('serves a cache hit within ttlMs without calling Django', async () => {
    const fetchFn = upstream()
    const auth = build(fetchFn)
    await auth.authenticate(session('abc'))
    clock = 59_999
    expect((await auth.authenticate(session('abc'))).kind).toBe('allow')
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('calls Django again once ttlMs has passed', async () => {
    const fetchFn = upstream()
    const auth = build(fetchFn)
    await auth.authenticate(session('abc'))
    clock = 60_000
    await auth.authenticate(session('abc'))
    expect(fetchFn).toHaveBeenCalledTimes(2)
  })

  it('refetches an unavailable result after failureTtlMs but keeps an allow result', async () => {
    const fetchFn = upstream()
    fetchFn.mockResolvedValueOnce(reply(null, 500))
    const auth = build(fetchFn, { ttlMs: 60_000, failureTtlMs: 1_000 })
    expect((await auth.authenticate(session('bad'))).kind).toBe('deny')
    expect((await auth.authenticate(session('good'))).kind).toBe('allow')
    expect(fetchFn).toHaveBeenCalledTimes(2)

    clock = 1_000
    expect((await auth.authenticate(session('bad'))).kind).toBe('allow')
    expect(fetchFn).toHaveBeenCalledTimes(3)
    expect((await auth.authenticate(session('good'))).kind).toBe('allow')
    expect(fetchFn).toHaveBeenCalledTimes(3)
  })

  it('shares one fetch between two concurrent calls for the same cookie', async () => {
    const fetchFn = upstream()
    const auth = build(fetchFn)
    const [first, second] = await Promise.all([auth.authenticate(session('abc')), auth.authenticate(session('abc'))])
    expect(first).toEqual(second)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('evicts the oldest entry once 1000 entries are cached', async () => {
    const fetchFn = upstream()
    const auth = build(fetchFn)
    for (let i = 0; i <= 1000; i++) await auth.authenticate(session(`c${i}`))
    expect(fetchFn).toHaveBeenCalledTimes(1001)

    await auth.authenticate(session('c1000'))
    expect(fetchFn).toHaveBeenCalledTimes(1001)

    await auth.authenticate(session('c1'))
    expect(fetchFn).toHaveBeenCalledTimes(1001)

    await auth.authenticate(session('c0'))
    expect(fetchFn).toHaveBeenCalledTimes(1002)
  })

  it('invalidateUser drops only that user allow entries', async () => {
    const fetchFn = upstream()
    fetchFn.mockResolvedValueOnce(reply({ ...ME, id: 1 }))
    fetchFn.mockResolvedValueOnce(reply({ ...ME, id: 2 }))
    fetchFn.mockResolvedValueOnce(reply(null, 401))
    const auth = build(fetchFn)
    await auth.authenticate(session('u1'))
    await auth.authenticate(session('u2'))
    await auth.authenticate(session('bad'))
    expect(fetchFn).toHaveBeenCalledTimes(3)

    auth.invalidateUser(1)

    fetchFn.mockResolvedValueOnce(reply({ ...ME, id: 1 }))
    await auth.authenticate(session('u1'))
    expect(fetchFn).toHaveBeenCalledTimes(4)
    await auth.authenticate(session('u2'))
    await auth.authenticate(session('bad'))
    expect(fetchFn).toHaveBeenCalledTimes(4)
  })

  it('uses the global fetch and Date.now when no fetch or clock is given', async () => {
    const fetchFn = upstream()
    vi.stubGlobal('fetch', fetchFn)
    const auth = createDjangoStaffAuthenticator({ baseUrl: BASE, roles: ROLES })
    expect((await auth.authenticate(session('abc'))).kind).toBe('allow')
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })
})
