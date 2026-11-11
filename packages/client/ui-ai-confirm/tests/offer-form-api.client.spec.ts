/** Private draft-offer API behavior and bounded response parsing. */
import { describe, expect, it } from 'vitest'
import { ApplicationFormError } from '../src/client/application-form-api.ts'
import { createOfferFormApi, type OfferDraft } from '../src/client/offer-form-api.ts'

const draft: OfferDraft = {
  id: 4, application: 7, status: 'DRAFT', currency: 'GHS',
  tuition_fee: '1000.00', registration_fee: '0.00', admission_fee: '0.00', accommodation_fee: '0.00',
  exam_assessment_fee: '0.00', student_services_fee: '0.00', graduation_exit_fee: '0.00', other_fees: '0.00',
  other_fees_description: '', program_duration: '', study_mode: '', program_start_date: null,
  partner_institution: '', prepared_by_name: '', requires_visa_flight: false, notes: '',
  offer_scholarships: [{ scholarship: 3, amount: '10.00', notes: '' }],
  total_fees: '1000.00', total_scholarships: '10.00', net_fee_payable: '990.00',
}

function scripted(replies: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const fetcher: typeof fetch = async (url, init) => {
    const address = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
    calls.push({ url: address, init })
    const reply = replies.shift()
    if (reply === undefined) throw new Error('unscripted request')
    if (reply instanceof Error) throw reply
    return reply
  }
  return { api: createOfferFormApi({ fetch: fetcher, apiPath: '/api/v1' }), calls }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const csrf = () => json({ csrfToken: 'csrf' })
async function kind(promise: Promise<unknown>) {
  try { await promise } catch (error) { return error instanceof ApplicationFormError ? error.kind : undefined }
}

describe('private offer form API', () => {
  it('builds the saved-draft preview URL and refuses an invalid ID', () => {
    const { api, calls } = scripted([])
    expect(api.previewUrl(7)).toBe('/api/v1/admissions/staff/applications/7/offer/preview/')
    expect(() => api.previewUrl(0)).toThrow(ApplicationFormError)
    expect(calls).toEqual([])
  })

  it('loads a draft without retaining unrelated response fields', async () => {
    const { api, calls } = scripted([json({ offer: { ...draft, email: 'private@example.test' } })])
    expect(await api.load(7)).toEqual(draft)
    expect(calls[0]).toMatchObject({ url: '/api/v1/admissions/staff/applications/7/offer/', init: {
      method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
    } })
  })

  it('loads absence and rejects mismatched or malformed drafts', async () => {
    expect(await scripted([json({ offer: null })]).api.load(7)).toBeNull()
    for (const offer of [{ ...draft, application: 8 }, { ...draft, status: 'SENT' }, { ...draft, tuition_fee: '1e9' },
      { ...draft, offer_scholarships: Array(51).fill(draft.offer_scholarships[0]) }]) {
      expect(await kind(scripted([json({ offer })]).api.load(7))).toBe('unavailable')
    }
  })

  it('accepts an ISO start date and rejects a malformed one', async () => {
    expect((await scripted([json({ offer: { ...draft, program_start_date: '2026-01-15' } })]).api.load(7))?.program_start_date)
      .toBe('2026-01-15')
    expect(await kind(scripted([json({ offer: { ...draft, program_start_date: '2026/01/15' } })]).api.load(7)))
      .toBe('unavailable')
  })

  it('uses CSRF preflight and the explicitly selected POST or PATCH without retry', async () => {
    for (const [create, method, status] of [[true, 'POST', 201], [false, 'PATCH', 200]] as const) {
      const body = { tuition_fee: '1000.00' }
      const { api, calls } = scripted([csrf(), json(draft, status)])
      expect(await api.save(7, body, create)).toEqual(draft)
      expect(calls.map(call => call.url)).toEqual([
        '/api/v1/users/csrf-token/', '/api/v1/admissions/staff/applications/7/offer/',
      ])
      expect(calls[1]?.init).toEqual({
        method, body: JSON.stringify(body), headers: {
          Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRFToken': 'csrf',
        }, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      })
    }
  })

  it.each([0, -1, 1.5, NaN])('refuses invalid IDs before requests (%s)', async (id) => {
    const { api, calls } = scripted([])
    expect(await kind(api.load(id))).toBe('invalid')
    expect(await kind(api.save(id, {}, true))).toBe('invalid')
    expect(calls).toHaveLength(0)
  })

  it.each([[401, 'sign-in'], [403, 'sign-in'], [400, 'invalid'], [404, 'invalid'], [409, 'invalid'],
    [413, 'invalid'], [429, 'invalid'], [500, 'unknown']] as const)('classifies write status %i', async (status, expected) => {
    const { api, calls } = scripted([csrf(), json({}, status)])
    expect(await kind(api.save(7, {}, true))).toBe(expected)
    expect(calls).toHaveLength(2)
  })

  it('marks lost or unreadable successful write responses unknown and never retries', async () => {
    for (const response of [new Error('offline'), new Response('bad json', { status: 201 }), json({ ...draft, application: 9 }, 201)]) {
      const { api, calls } = scripted([csrf(), response])
      expect(await kind(api.save(7, {}, true))).toBe('unknown')
      expect(calls).toHaveLength(2)
    }
  })

  it('does not write if the CSRF preflight fails', async () => {
    const { api, calls } = scripted([json({}, 503)])
    expect(await kind(api.save(7, {}, true))).toBe('unavailable')
    expect(calls).toHaveLength(1)
  })
})
