/** Private staff offer requests; response text stays out of model-visible results. */
import { ApplicationFormError } from './application-form-api.ts'
import { isId, isRecord } from './model.ts'

const FEE_FIELDS = [
  'tuition_fee', 'registration_fee', 'admission_fee', 'accommodation_fee',
  'exam_assessment_fee', 'student_services_fee', 'graduation_exit_fee', 'other_fees',
] as const

/** One bounded scholarship allocation returned by Django. */
export interface OfferScholarship {
  readonly scholarship: number
  readonly amount: string
  readonly notes: string
}

/** Fixed fields retained from a private draft offer response. */
export interface OfferDraft {
  readonly id: number
  readonly application: number
  readonly status: 'DRAFT'
  readonly currency: string
  readonly tuition_fee: string
  readonly registration_fee: string
  readonly admission_fee: string
  readonly accommodation_fee: string
  readonly exam_assessment_fee: string
  readonly student_services_fee: string
  readonly graduation_exit_fee: string
  readonly other_fees: string
  readonly other_fees_description: string
  readonly program_duration: string
  readonly study_mode: string
  readonly program_start_date: string | null
  readonly partner_institution: string
  readonly prepared_by_name: string
  readonly requires_visa_flight: boolean
  readonly notes: string
  readonly offer_scholarships: readonly OfferScholarship[]
  readonly total_fees: string
  readonly total_scholarships: string
  readonly net_fee_payable: string
}

/** Session-only operations used by a staff offer form. */
export interface OfferFormApi {
  /** Load the existing draft, or null when no draft exists. */
  load(applicationId: number): Promise<OfferDraft | null>
  /** Save once using POST for creation or PATCH for an existing draft. */
  save(applicationId: number, body: Record<string, unknown>, create: boolean): Promise<OfferDraft>
  /** The session-only URL that renders the saved draft's letter inline. */
  previewUrl(applicationId: number): string
}

function money(value: unknown, digits: number): value is string {
  return typeof value === 'string' && new RegExp(`^(?:0|[1-9]\\d{0,${digits - 3}})\\.\\d{2}$`).test(value)
}

function currency(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z]{3}$/.test(value)
}

function parseScholarship(line: unknown): OfferScholarship {
  if (!isRecord(line) || !isId(line.scholarship) || !money(line.amount, 10)
    || typeof line.notes !== 'string' || line.notes.length > 5000) throw new ApplicationFormError('unavailable')
  return { scholarship: line.scholarship, amount: line.amount, notes: line.notes }
}

function parseDetails(value: Record<string, unknown>): Pick<OfferDraft,
  'other_fees_description' | 'program_duration' | 'study_mode' | 'program_start_date' |
  'partner_institution' | 'prepared_by_name' | 'requires_visa_flight' | 'notes'> {
  const fields = ['other_fees_description', 'program_duration', 'study_mode', 'partner_institution', 'prepared_by_name', 'notes'] as const
  const limits = [5000, 50, 20, 200, 200, 5000]
  if (fields.some((field, index) => typeof value[field] !== 'string' || (value[field]).length > (limits[index] ?? 0))
    || (value.program_start_date !== null && (typeof value.program_start_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.program_start_date)))
    || typeof value.requires_visa_flight !== 'boolean') throw new ApplicationFormError('unavailable')
  return {
    other_fees_description: value.other_fees_description as string,
    program_duration: value.program_duration as string,
    study_mode: value.study_mode as string,
    program_start_date: value.program_start_date,
    partner_institution: value.partner_institution as string,
    prepared_by_name: value.prepared_by_name as string,
    requires_visa_flight: value.requires_visa_flight,
    notes: value.notes as string,
  }
}

function parseOfferHeader(value: Record<string, unknown>, applicationId: number): Pick<OfferDraft, 'id' | 'currency'> {
  if (!isId(value.id) || value.application !== applicationId || value.status !== 'DRAFT' || !currency(value.currency)) {
    throw new ApplicationFormError('unavailable')
  }
  return { id: value.id, currency: value.currency }
}

function parseOffer(value: unknown, applicationId: number): OfferDraft {
  if (!isRecord(value)) throw new ApplicationFormError('unavailable')
  const header = parseOfferHeader(value, applicationId)
  const feeFields = Object.fromEntries(FEE_FIELDS.map((field) => {
    if (!money(value[field], 10)) throw new ApplicationFormError('unavailable')
    return [field, value[field]]
  })) as Pick<OfferDraft, typeof FEE_FIELDS[number]>
  const strings = parseDetails(value)
  if (!Array.isArray(value.offer_scholarships) || value.offer_scholarships.length > 50) throw new ApplicationFormError('unavailable')
  const scholarships = value.offer_scholarships.map(parseScholarship)
  if (!money(value.total_fees, 12) || !money(value.total_scholarships, 12) || !money(value.net_fee_payable, 12)) {
    throw new ApplicationFormError('unavailable')
  }
  return {
    id: header.id, application: applicationId, status: 'DRAFT', currency: header.currency,
    ...feeFields, ...strings, offer_scholarships: scholarships,
    total_fees: value.total_fees, total_scholarships: value.total_scholarships, net_fee_payable: value.net_fee_payable,
  }
}

/** Create session-only requests for one application's staff offer draft. */
export function createOfferFormApi(options: { readonly fetch: typeof fetch; readonly apiPath: string }): OfferFormApi {
  const path = (id: number) => `${options.apiPath}/admissions/staff/applications/${id}/offer/`

  async function request(url: string, init: RequestInit, write = false): Promise<Response> {
    let response: Response
    try {
      response = await options.fetch(url, { ...init, credentials: 'same-origin', cache: 'no-store', redirect: 'error' })
    } catch {
      throw new ApplicationFormError(write ? 'unknown' : 'unavailable')
    }
    if ([401, 403].includes(response.status)) throw new ApplicationFormError('sign-in')
    if ([400, 404, 409, 413, 429].includes(response.status)) throw new ApplicationFormError('invalid')
    if (!response.ok) throw new ApplicationFormError(write ? 'unknown' : 'unavailable')
    return response
  }

  async function json(response: Response, write = false): Promise<unknown> {
    try { return await response.json() } catch {
      throw new ApplicationFormError(write ? 'unknown' : 'unavailable')
    }
  }

  return {
    previewUrl(applicationId) {
      if (!isId(applicationId)) throw new ApplicationFormError('invalid')
      return `${path(applicationId)}preview/`
    },
    async load(applicationId) {
      if (!isId(applicationId)) throw new ApplicationFormError('invalid')
      const value = await json(await request(path(applicationId), { method: 'GET', headers: { Accept: 'application/json' } }))
      if (!isRecord(value) || !('offer' in value)) throw new ApplicationFormError('unavailable')
      return value.offer === null ? null : parseOffer(value.offer, applicationId)
    },
    async save(applicationId, body, create) {
      if (!isId(applicationId)) throw new ApplicationFormError('invalid')
      const csrfResponse = await request(`${options.apiPath}/users/csrf-token/`, { method: 'GET' })
      const csrf = await json(csrfResponse)
      if (!isRecord(csrf) || typeof csrf.csrfToken !== 'string' || csrf.csrfToken === '') throw new ApplicationFormError('unavailable')
      const response = await request(path(applicationId), {
        method: create ? 'POST' : 'PATCH',
        body: JSON.stringify(body),
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRFToken': csrf.csrfToken },
      }, true)
      try {
        return parseOffer(await json(response, true), applicationId)
      } catch (error) {
        // A 2xx write may have committed; an unreadable or mismatched response is uncertain.
        if (error instanceof ApplicationFormError) throw new ApplicationFormError('unknown')
        throw error
      }
    },
  }
}
