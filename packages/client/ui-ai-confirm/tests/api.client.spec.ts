/** The card's network faces against a scripted fetch: requests it sends and how it classifies replies. */
import { describe, expect, it } from 'vitest'
import { ConfirmApiError, createConfirmApi, type ConfirmApi } from '../src/client/api.ts'
import { ACTIONS } from '../src/client/model.ts'

const [APPROVE, REJECT, REQUEST_DOCUMENTS] = ACTIONS as [(typeof ACTIONS)[0], (typeof ACTIONS)[1], (typeof ACTIONS)[2]]
const ID = '0b1d2c3e-4f50-4a61-8b72-93a4b5c6d7e8'

interface Call {
  readonly url: string
  readonly init: RequestInit
}

type Reply = Response | Error | (() => Response)

/** A fetch that answers from a script, one reply per call in order, and records every call. */
function scripted(replies: Reply[]): { api: ConfirmApi; calls: Call[] } {
  const calls: Call[] = []
  const fake = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const reply = replies.shift()
    if (reply === undefined) throw new Error('unscripted call')
    if (reply instanceof Error) throw reply
    return typeof reply === 'function' ? reply() : reply
  }) as typeof fetch
  return { api: createConfirmApi({ fetch: fake, toolsPath: '/tools/pending', apiPath: '/api/v1' }), calls }
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const failure = async (promise: Promise<unknown>): Promise<unknown> => promise.then(() => null, (error: unknown) => error)

async function kind(promise: Promise<unknown>): Promise<string | undefined> {
  const error = await failure(promise)
  return error instanceof ConfirmApiError ? error.kind : undefined
}

const PENDING = { id: ID, action: 'application.approve', ids: [7, 8], reason: 'Draft', expiresAt: '2026-11-03T15:00:00.000Z' }
const SUMMARY = { id: 7, name: 'Ama Mensah', reference: 'APP-7', status: 'UNDER_REVIEW', program: { code: 'NUR', name: 'Nursing' } }

describe('loadPending', () => {
  it('reads the batch from the tool service', async () => {
    const { api, calls } = scripted([json(PENDING)])

    expect(await api.loadPending(ID)).toEqual(PENDING)
    expect(calls[0]?.url).toBe(`/tools/pending/${ID}`)
    expect(calls[0]?.init.method).toBe('GET')
  })

  it.each([
    [401, 'sign-in'],
    [403, 'refused'],
    [410, 'expired'],
    [500, 'unavailable'],
    [503, 'unavailable'],
  ])('classifies HTTP %i as %s', async (status, expected) => {
    const { api } = scripted([json({ error: 'x' }, status)])

    expect(await kind(api.loadPending(ID))).toBe(expected)
  })

  it('classifies a network failure as unavailable', async () => {
    const { api } = scripted([new Error('connection refused')])

    expect(await kind(api.loadPending(ID))).toBe('unavailable')
  })

  it.each([
    ['an answer that is not JSON', new Response('<html>', { status: 200 })],
    ['a body that is not an object', json([])],
    ['an id that is not text', json({ ...PENDING, id: 5 })],
    ['no ids', json({ ...PENDING, ids: [] })],
    ['too many ids', json({ ...PENDING, ids: Array.from({ length: 26 }, (_, index) => index + 1) })],
    ['a bad id in the list', json({ ...PENDING, ids: [7, 0] })],
    ['a reason that is not text', json({ ...PENDING, reason: 3 })],
    ['an expiry that is not text', json({ ...PENDING, expiresAt: 3 })],
  ])('treats %s as unavailable', async (_label, reply) => {
    const { api } = scripted([reply])

    expect(await kind(api.loadPending(ID))).toBe('unavailable')
  })

  it('encodes the id in the path', async () => {
    const { api, calls } = scripted([json(PENDING)])

    await api.loadPending('a/b c')

    expect(calls[0]?.url).toBe('/tools/pending/a%2Fb%20c')
  })
})

describe('loadSummaries', () => {
  it('asks Django for the records by id', async () => {
    const { api, calls } = scripted([json({ applications: [SUMMARY] })])

    expect(await api.loadSummaries([7, 8])).toEqual([SUMMARY])
    expect(calls[0]?.url).toBe('/api/v1/admissions/staff/application-summaries/?ids=7,8')
  })

  it.each([
    [401, 'sign-in'],
    [403, 'sign-in'],
    [500, 'unavailable'],
  ])('classifies HTTP %i as %s', async (status, expected) => {
    const { api } = scripted([json({}, status)])

    expect(await kind(api.loadSummaries([7]))).toBe(expected)
  })

  it.each([
    ['an answer that is not JSON', new Response('x', { status: 200 })],
    ['a body with no list', json({})],
    ['a body that is not an object', json('x')],
    ['a record with a bad id', json({ applications: [{ ...SUMMARY, id: 'x' }] })],
    ['a record with no program', json({ applications: [{ ...SUMMARY, program: null }] })],
    ['a record with a non-text name', json({ applications: [{ ...SUMMARY, name: 5 }] })],
    ['a record with a non-text program code', json({ applications: [{ ...SUMMARY, program: { code: 1, name: 'x' } }] })],
  ])('treats %s as unavailable', async (_label, reply) => {
    const { api } = scripted([reply])

    expect(await kind(api.loadSummaries([7]))).toBe('unavailable')
  })

  it('classifies a network failure as unavailable', async () => {
    const { api } = scripted([new Error('offline')])

    expect(await kind(api.loadSummaries([7]))).toBe('unavailable')
  })
})

describe('claim', () => {
  it('uses the batch up with a POST', async () => {
    const { api, calls } = scripted([json({ id: ID })])

    await api.claim(ID)

    expect(calls[0]?.url).toBe(`/tools/pending/${ID}/consume`)
    expect(calls[0]?.init.method).toBe('POST')
  })

  it.each([
    [401, 'sign-in'],
    [403, 'refused'],
    [410, 'expired'],
    [502, 'unavailable'],
  ])('classifies HTTP %i as %s', async (status, expected) => {
    const { api } = scripted([json({}, status)])

    expect(await kind(api.claim(ID))).toBe(expected)
  })
})

describe('mintWriteToken', () => {
  it('echoes Django’s CSRF token and asks for exactly this action, these records and this reason', async () => {
    const { api, calls } = scripted([json({ csrfToken: 'csrf-1' }), json({ token: 'write-token', expires_in: 120 })])

    expect(await api.mintWriteToken(REJECT, [7, 8], 'Passport unreadable')).toBe('write-token')

    expect(calls[0]?.url).toBe('/api/v1/users/csrf-token/')
    expect(calls[1]?.url).toBe('/api/v1/ai/token/')
    expect((calls[1]?.init.headers as Record<string, string>)['X-CSRFToken']).toBe('csrf-1')
    expect(JSON.parse(calls[1]?.init.body as string)).toEqual({
      kind: 'write',
      action: 'application.reject',
      ids: [7, 8],
      reason: 'Passport unreadable',
    })
  })

  it('sends no reason for an action that takes none, even if one is passed', async () => {
    const { api, calls } = scripted([json({ csrfToken: 'c' }), json({ token: 't' })])

    await api.mintWriteToken(APPROVE, [7], 'ignored')

    expect(JSON.parse(calls[1]?.init.body as string)).toEqual({ kind: 'write', action: 'application.approve', ids: [7] })
  })

  it('sends no reason when an optional one is empty', async () => {
    const { api, calls } = scripted([json({ csrfToken: 'c' }), json({ token: 't' })])

    await api.mintWriteToken(REJECT, [7], '')

    expect(JSON.parse(calls[1]?.init.body as string)).not.toHaveProperty('reason')
  })

  it.each([
    [401, 'sign-in'],
    [403, 'sign-in'],
    [400, 'refused'],
    [503, 'unavailable'],
    [500, 'unavailable'],
  ])('classifies HTTP %i from the token endpoint as %s', async (status, expected) => {
    const { api } = scripted([json({ csrfToken: 'c' }), json({ detail: 'x' }, status)])

    expect(await kind(api.mintWriteToken(APPROVE, [7], ''))).toBe(expected)
  })

  it.each([
    ['a CSRF endpoint that fails', [json({}, 500)]],
    ['a CSRF answer with no token', [json({})]],
    ['a CSRF answer that is not JSON', [new Response('x', { status: 200 })]],
    ['a token answer with no token', [json({ csrfToken: 'c' }), json({})]],
    ['a token answer that is not JSON', [json({ csrfToken: 'c' }), new Response('x', { status: 200 })]],
    ['a network failure on the token call', [json({ csrfToken: 'c' }), new Error('offline')]],
  ] as [string, Reply[]][])('treats %s as unavailable', async (_label, replies) => {
    const { api } = scripted(replies)

    expect(await kind(api.mintWriteToken(APPROVE, [7], ''))).toBe('unavailable')
  })
})

describe('write', () => {
  it('sends the write token as a Bearer header and the reason in the body', async () => {
    const { api, calls } = scripted([json({ status: 'DOCUMENTS_REQUIRED' })])

    expect(await api.write(REQUEST_DOCUMENTS, 7, 'write-token', 'Clearer scan')).toEqual({ ok: true })

    expect(calls[0]?.url).toBe('/api/v1/admissions/applications/7/request_documents/')
    expect(calls[0]?.init.method).toBe('POST')
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe('Bearer write-token')
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({ reason: 'Clearer scan' })
  })

  it('sends an empty body for an action that takes no reason', async () => {
    const { api, calls } = scripted([json({})])

    await api.write(APPROVE, 7, 't', 'ignored')

    expect(calls[0]?.init.body).toBe('{}')
  })

  it("passes on Django's explanation when it refuses a write", async () => {
    const { api } = scripted([json({ error: 'An application with status "Approved" cannot be approved.' }, 400)])

    expect(await api.write(APPROVE, 7, 't', '')).toEqual({
      ok: false,
      kind: 'rejected',
      detail: 'An application with status "Approved" cannot be approved.',
    })
  })

  it('reports a refusal with no readable explanation as a bare rejection', async () => {
    const unreadable = scripted([new Response('<html>', { status: 400 })])
    const noMessage = scripted([json({ other: 1 }, 400)])

    expect(await unreadable.api.write(APPROVE, 7, 't', '')).toEqual({ ok: false, kind: 'rejected', detail: '' })
    expect(await noMessage.api.write(APPROVE, 7, 't', '')).toEqual({ ok: false, kind: 'rejected', detail: '' })
  })

  it.each([
    [404, 'missing'],
    [401, 'refused'],
    [403, 'refused'],
    [500, 'unavailable'],
  ])('classifies HTTP %i as %s', async (status, expected) => {
    const { api } = scripted([json({}, status)])

    expect(await api.write(APPROVE, 7, 't', '')).toEqual({ ok: false, kind: expected })
  })

  it('reports a network failure as unavailable instead of throwing', async () => {
    const { api } = scripted([new Error('offline')])

    expect(await api.write(APPROVE, 7, 't', '')).toEqual({ ok: false, kind: 'unavailable' })
  })
})
