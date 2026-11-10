/** Private staff-form requests go directly to Django; response text never becomes chat content. */
import { isId, isRecord } from './model.ts'

/** Expected failure of a private form request; unknown means a write may have committed. */
export class ApplicationFormError extends Error {
  constructor(readonly kind: 'sign-in' | 'invalid' | 'unavailable' | 'unknown') {
    super(kind)
  }
}

/** One privately loaded option. */
export interface FormChoice {
  readonly id: number
  readonly name: string
}

/** Upload limits supplied by Django for one document type. */
export interface DocumentChoice extends FormChoice {
  readonly isRequired: boolean
  readonly acceptedFormats: string
  readonly maxSizeMb: number
}

/** One bounded page of staff-only choices. */
export interface ApplicationCatalog {
  readonly page: number
  readonly hasMore: boolean
  readonly programs: readonly FormChoice[]
  readonly intakes: readonly FormChoice[]
  readonly documents: readonly DocumentChoice[]
}

/** Safe fields retained from a staff create response, not a model-facing result. */
export interface CreatedApplication {
  readonly id: number
  readonly reference: string
  readonly status: string
  readonly createdNew: boolean
}

/** A matching record is for staff inspection only, never proof of a particular request's outcome. */
export interface ReconciledApplication {
  readonly id: number
  readonly reference: string
  readonly status: string
  readonly documentTypeIds: readonly number[]
}

/** Private operations used only by the application form. */
export interface ApplicationFormApi {
  /** Load one catalog page without exposing choices through tools. */
  catalog(page: number): Promise<ApplicationCatalog>
  /** Whether identity entry is supported; secure-vault mode remains unavailable. */
  creationAvailable(): Promise<boolean>
  /** Submit once. A network/server/unreadable-success failure is unknown, never safe to retry. */
  create(body: FormData): Promise<CreatedApplication>
  /** Attach once. Unknown failures must not trigger an automatic resubmission. */
  upload(applicationId: number, body: FormData): Promise<void>
  /** Inspect a possible matching active application; absence does not authorize a retry. */
  reconcile(email: string, program: number): Promise<ReconciledApplication | null>
}

function choice(value: unknown): FormChoice {
  if (!isRecord(value) || !isId(value.id) || typeof value.name !== 'string' || value.name.length > 200) {
    throw new ApplicationFormError('unavailable')
  }
  return { id: value.id, name: value.name }
}

function documentChoice(value: unknown): DocumentChoice {
  const base = choice(value)
  if (!isRecord(value) || typeof value.is_required !== 'boolean' || typeof value.accepted_formats !== 'string'
    || typeof value.max_size_mb !== 'number' || !Number.isFinite(value.max_size_mb) || value.max_size_mb <= 0) {
    throw new ApplicationFormError('unavailable')
  }
  return { ...base, isRequired: value.is_required, acceptedFormats: value.accepted_formats, maxSizeMb: value.max_size_mb }
}

function boundedChoices<T>(value: unknown, parse: (row: unknown) => T): readonly T[] {
  if (!Array.isArray(value) || value.length > 50) throw new ApplicationFormError('unavailable')
  return value.map(parse)
}

function application(value: unknown): { id: number; reference: string; status: string } {
  if (!isRecord(value) || !isId(value.id) || typeof value.reference !== 'string' || value.reference.length > 200
    || typeof value.status !== 'string' || value.status.length > 50) throw new ApplicationFormError('unavailable')
  return { id: value.id, reference: value.reference, status: value.status }
}

/**
 * Build session/CSRF-only form requests, independent of AI write tokens and pending batches.
 * @param options - browser fetch and same-origin Django prefix fixed by plugin configuration.
 * @returns private form operations; all writes are one attempt only.
 */
export function createApplicationFormApi(options: { readonly fetch: typeof fetch; readonly apiPath: string }): ApplicationFormApi {
  const path = (suffix: string): string => `${options.apiPath}/${suffix}`

  async function request(url: string, init: RequestInit, write = false): Promise<Response> {
    let response: Response
    try {
      response = await options.fetch(url, { ...init, credentials: 'same-origin', cache: 'no-store', redirect: 'error' })
    } catch {
      throw new ApplicationFormError(write ? 'unknown' : 'unavailable')
    }
    if ([401, 403].includes(response.status)) throw new ApplicationFormError('sign-in')
    if ([400, 404, 409, 413, 429].includes(response.status)) {
      throw new ApplicationFormError('invalid')
    }
    if (!response.ok) throw new ApplicationFormError(write ? 'unknown' : 'unavailable')
    return response
  }

  async function json(response: Response): Promise<unknown> {
    try { return await response.json() } catch { throw new ApplicationFormError('unavailable') }
  }

  async function post(suffix: string, body: BodyInit, contentType?: string, write = false): Promise<Response> {
    const csrfResponse = await request(path('users/csrf-token/'), { method: 'GET' })
    const csrf = await json(csrfResponse)
    if (!isRecord(csrf) || typeof csrf.csrfToken !== 'string' || csrf.csrfToken === '') throw new ApplicationFormError('unavailable')
    return request(path(suffix), {
      method: 'POST', body,
      headers: { Accept: 'application/json', 'X-CSRFToken': csrf.csrfToken, ...(contentType ? { 'Content-Type': contentType } : {}) },
    }, write)
  }

  return {
    async catalog(page) {
      if (!Number.isInteger(page) || page < 1 || page > 1000) throw new ApplicationFormError('invalid')
      const value = await json(await request(path(`admissions/staff/application-catalog/?page=${page}`), { method: 'GET' }))
      if (!isRecord(value) || value.page !== page || typeof value.has_more !== 'boolean') throw new ApplicationFormError('unavailable')
      return {
        page, hasMore: value.has_more,
        programs: boundedChoices(value.programs, choice), intakes: boundedChoices(value.intakes, choice),
        documents: boundedChoices(value.document_types, documentChoice),
      }
    },
    async creationAvailable() {
      const value = await json(await request(path('admissions/applications/public-config/'), { method: 'GET' }))
      if (!isRecord(value) || typeof value.tokenization_enabled !== 'boolean') throw new ApplicationFormError('unavailable')
      return !value.tokenization_enabled
    },
    async create(body) {
      const response = await post('admissions/staff/applications/', body, undefined, true)
      // Once Django accepted the write, an invalid response must not reopen Submit.
      try {
        const value = await json(response)
        if (!isRecord(value) || typeof value.created_new !== 'boolean') throw new ApplicationFormError('unavailable')
        return { ...application({ ...value, reference: value.application_id }), createdNew: value.created_new }
      } catch {
        throw new ApplicationFormError('unknown')
      }
    },
    async upload(applicationId, body) {
      if (!isId(applicationId)) throw new ApplicationFormError('invalid')
      await post(`admissions/staff/applications/${applicationId}/documents/`, body, undefined, true)
    },
    async reconcile(email, program) {
      if (!isId(program)) throw new ApplicationFormError('invalid')
      const response = await post('admissions/staff/application-reconciliation/', JSON.stringify({ email, program_id: program }), 'application/json')
      const value = await json(response)
      if (!isRecord(value)) throw new ApplicationFormError('unavailable')
      if (value.application === null) return null
      const match = application(value.application)
      const ids = isRecord(value.application) ? value.application.document_type_ids : undefined
      if (!Array.isArray(ids) || ids.length > 25 || !ids.every(isId)) throw new ApplicationFormError('unavailable')
      return { ...match, documentTypeIds: ids }
    },
  }
}
