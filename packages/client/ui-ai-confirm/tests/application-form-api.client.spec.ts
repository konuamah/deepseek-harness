/** Private staff form requests and conservative write-outcome handling. */
import { describe, expect, it } from 'vitest'
import { ApplicationFormError, createApplicationFormApi } from '../src/client/application-form-api.ts'

function scripted(replies: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const fake: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init })
    const reply = replies.shift()
    if (reply === undefined) throw new Error('unscripted request')
    if (reply instanceof Error) throw reply
    return reply
  }
  return { api: createApplicationFormApi({ fetch: fake, apiPath: '/api/v1' }), calls }
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status })
const csrf = (): Response => json({ csrfToken: 'private-csrf' })
const created = { id: 7, application_id: 'APP-7', status: 'PENDING', created_new: true }
const catalog = {
  page: 1, has_more: false,
  programs: [{ id: 2, name: 'Nursing', code: 'NUR' }],
  intakes: [{ id: 3, name: 'Autumn' }],
  document_types: [{ id: 4, name: 'Transcript', is_required: true, accepted_formats: 'pdf,png', max_size_mb: 5 }],
}

async function kind(promise: Promise<unknown>): Promise<string | undefined> {
  try { await promise } catch (error) {
    return error instanceof ApplicationFormError ? error.kind : undefined
  }
  return undefined
}

describe('private application catalog', () => {
  it('retains only form choices and server upload limits', async () => {
    const { api, calls } = scripted([json(catalog)])
    expect(await api.catalog(1)).toEqual({
      page: 1, hasMore: false, programs: [{ id: 2, name: 'Nursing' }], intakes: [{ id: 3, name: 'Autumn' }],
      documents: [{ id: 4, name: 'Transcript', isRequired: true, acceptedFormats: 'pdf,png', maxSizeMb: 5 }],
    })
    expect(calls[0]).toMatchObject({ url: '/api/v1/admissions/staff/application-catalog/?page=1', init: {
      method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
    } })
  })

  it.each([0, -1, 1.5, 1001, NaN])('refuses invalid page %s before fetching', async (page) => {
    const { api, calls } = scripted([])
    expect(await kind(api.catalog(page))).toBe('invalid')
    expect(calls).toHaveLength(0)
  })

  it('accepts the maximum page and fifty choices', async () => {
    const { api } = scripted([json({ ...catalog, page: 1000, has_more: true,
      programs: Array.from({ length: 50 }, (_, i) => ({ id: i + 1, name: 'Program' })),
    })])
    expect(await api.catalog(1000)).toMatchObject({ page: 1000, hasMore: true, programs: expect.any(Array) })
  })

  it.each([
    null, { ...catalog, page: 2 }, { ...catalog, has_more: 'yes' },
    { ...catalog, programs: Array(51).fill({ id: 1, name: 'Program' }) },
    { ...catalog, programs: [{ id: 0, name: 'Program' }] },
    { ...catalog, intakes: [{ id: 1, name: 'x'.repeat(201) }] },
    ...[false, 0, -1, '5'].map(max_size_mb => ({ ...catalog, document_types: [{ ...catalog.document_types[0], max_size_mb }] })),
    { ...catalog, document_types: [{ ...catalog.document_types[0], accepted_formats: [] }] },
    { ...catalog, document_types: [{ ...catalog.document_types[0], is_required: 'yes' }] },
  ])('refuses malformed catalog data %#', async (body) => {
    const { api } = scripted([json(body)])
    expect(await kind(api.catalog(1))).toBe('unavailable')
  })

  it.each([true, false])('reports creation capability when tokenization is %s', async (enabled) => {
    const { api } = scripted([json({ tokenization_enabled: enabled })])
    expect(await api.creationAvailable()).toBe(!enabled)
  })

  it('does not assume creation is supported if capability is missing', async () => {
    const { api } = scripted([json({})])
    expect(await kind(api.creationAvailable())).toBe('unavailable')
  })
})

describe('private application writes', () => {
  it.each([true, false])('parses created_new=%s without retaining private response fields', async (created_new) => {
    const { api, calls } = scripted([csrf(), json({ ...created, created_new, email: 'synthetic@example.test', admin_notes: 'private' }, 201)])
    const body = new FormData()
    body.append('email', 'synthetic@example.test')
    body.append('document_4', new Blob(['%PDF-1.7 synthetic'], { type: 'application/pdf' }), 'transcript.pdf')
    expect(await api.create(body)).toEqual({ id: 7, reference: 'APP-7', status: 'PENDING', createdNew: created_new })
    expect(calls.map(call => call.url)).toEqual(['/api/v1/users/csrf-token/', '/api/v1/admissions/staff/applications/'])
    expect(calls[1]?.init).toEqual({
      method: 'POST', body, headers: { Accept: 'application/json', 'X-CSRFToken': 'private-csrf' },
      credentials: 'same-origin', cache: 'no-store', redirect: 'error',
    })
  })

  it('uploads directly once without parsing or exposing response text', async () => {
    const { api, calls } = scripted([csrf(), new Response('private response', { status: 201 })])
    const body = new FormData()
    await api.upload(7, body)
    expect(calls[1]?.url).toBe('/api/v1/admissions/staff/applications/7/documents/')
    expect(calls[1]?.init?.body).toBe(body)
    expect(calls[1]?.init?.headers).toEqual({ Accept: 'application/json', 'X-CSRFToken': 'private-csrf' })
    expect(calls).toHaveLength(2)
  })

  it.each([0, -1, 1.5, NaN])('refuses invalid upload ID %s before fetching', async (id) => {
    const { api, calls } = scripted([])
    expect(await kind(api.upload(id, new FormData()))).toBe('invalid')
    expect(calls).toHaveLength(0)
  })

  it.each([
    [401, 'sign-in'], [403, 'sign-in'], [400, 'invalid'], [404, 'invalid'],
    [409, 'invalid'], [413, 'invalid'], [429, 'invalid'], [500, 'unknown'], [503, 'unknown'],
  ])('classifies write HTTP %i as %s without a retry', async (status, expected) => {
    const { api, calls } = scripted([csrf(), json({ detail: 'private backend text' }, status)])
    expect(await kind(api.create(new FormData()))).toBe(expected)
    expect(calls).toHaveLength(2)
  })

  it.each([
    () => new Error('private network text'),
    () => new Response('<html>private text</html>', { status: 201 }),
    () => json({ ...created, created_new: undefined }, 201),
    () => json({ ...created, id: 0 }, 201),
    () => json({ ...created, application_id: null }, 201),
  ])('keeps an uncertain accepted write unknown %#', async (reply) => {
    const { api, calls } = scripted([csrf(), reply()])
    expect(await kind(api.create(new FormData()))).toBe('unknown')
    expect(calls).toHaveLength(2)
  })

  it.each([() => new Error('offline'), () => json({}), () => json({ csrfToken: '' }), () => json({}, 503)])(
    'does not write when CSRF preflight fails %#', async (reply) => {
      const { api, calls } = scripted([reply()])
      expect(await kind(api.create(new FormData()))).toBe('unavailable')
      expect(calls).toHaveLength(1)
    },
  )

  it('does not retry an uncertain upload', async () => {
    const { api, calls } = scripted([csrf(), new Error('response lost')])
    expect(await kind(api.upload(7, new FormData()))).toBe('unknown')
    expect(calls).toHaveLength(2)
  })
})

describe('private inspection after an uncertain request', () => {
  it('posts private identifiers in the body and retains only bounded candidate fields', async () => {
    const { api, calls } = scripted([csrf(), json({ application: {
      id: 7, reference: 'APP-7', status: 'PENDING', document_type_ids: [4], email: 'synthetic@example.test',
    } })])
    expect(await api.reconcile('synthetic@example.test', 2)).toEqual({ id: 7, reference: 'APP-7', status: 'PENDING', documentTypeIds: [4] })
    expect(calls[1]).toMatchObject({ url: '/api/v1/admissions/staff/application-reconciliation/', init: {
      body: JSON.stringify({ email: 'synthetic@example.test', program_id: 2 }),
      headers: { Accept: 'application/json', 'X-CSRFToken': 'private-csrf', 'Content-Type': 'application/json' },
    } })
  })

  it('returns absence without issuing a write', async () => {
    const { api, calls } = scripted([csrf(), json({ application: null })])
    expect(await api.reconcile('synthetic@example.test', 2)).toBeNull()
    expect(calls).toHaveLength(2)
  })

  it.each([[], [0], Array(26).fill(4)])('validates candidate document IDs %#', async (ids) => {
    const { api } = scripted([csrf(), json({ application: { id: 7, reference: 'APP-7', status: 'PENDING', document_type_ids: ids } })])
    if (ids.length === 0) expect(await api.reconcile('synthetic@example.test', 2)).toMatchObject({ documentTypeIds: [] })
    else expect(await kind(api.reconcile('synthetic@example.test', 2))).toBe('unavailable')
  })

  it('refuses invalid program IDs before fetching', async () => {
    const { api, calls } = scripted([])
    expect(await kind(api.reconcile('synthetic@example.test', 0))).toBe('invalid')
    expect(calls).toHaveLength(0)
  })

  it('classifies a lost read response as unavailable, not a write outcome', async () => {
    const { api } = scripted([csrf(), new Error('offline')])
    expect(await kind(api.reconcile('synthetic@example.test', 2))).toBe('unavailable')
  })
})
