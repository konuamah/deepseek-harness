/**
 * The card's two network faces, both on the page's own origin: the tool service (the pending batch)
 * and Django (names, the write token, the writes). Every failure becomes one of four kinds the card
 * can explain; no response text from either side is shown except Django's own refusal of a write.
 * The module takes `fetch` as a parameter, so tests drive it without a network.
 */
import { isId, isRecord, type ActionSpec, type Resource } from './model.ts'

/** Why a call could not complete. */
export type FailureKind = 'sign-in' | 'expired' | 'refused' | 'unavailable'

/** A failed call, classified. The message is the kind: the card owns all user-facing copy. */
export class ConfirmApiError extends Error {
  constructor(readonly kind: FailureKind) {
    super(kind)
  }
}

/** The prepared batch as the tool service holds it for its owner. */
export interface PendingView {
  readonly id: string
  readonly action: string
  readonly ids: readonly number[]
  /** The reason the AI drafted; staff may edit it before confirming. */
  readonly reason: string
  readonly expiresAt: string
}

/** One application as the staff card shows it. Names come from Django with the staff session. */
export interface ApplicationSummary {
  readonly id: number
  readonly name: string
  readonly reference: string
  readonly program: { readonly code: string; readonly name: string }
  readonly status: string
}

/** One document as the staff card shows it; the name comes from Django with the staff session. */
export interface DocumentSummary {
  readonly id: number
  readonly name: string
  readonly reference: string
  readonly documentType: string
  readonly status: string
  readonly previewable: boolean
}

/** A file the staff can view or download for one application. */
export interface ApplicationFile {
  readonly id: number
  readonly kind: 'uploaded' | 'official'
  readonly title: string
  readonly status: string | null
  readonly availableToApplicant: boolean | null
  readonly previewable: boolean
}

/** A row of the staff summaries call for either resource. */
export type Summary = ApplicationSummary | DocumentSummary
/** Whether a document URL opens a preview or downloads the file. */
export type DocumentMode = 'view' | 'download'

/** The result of one write. */
export type RecordOutcome =
  | { readonly ok: true }
  /** Django refused with an explanation, for example a status that no longer allows the action. */
  | { readonly ok: false; readonly kind: 'rejected'; readonly detail: string }
  | { readonly ok: false; readonly kind: 'refused' | 'missing' | 'unavailable' }

/** Where the card's two faces live. Both are paths on the page's own origin. */
export interface ConfirmApiOptions {
  readonly fetch: typeof fetch
  /** Tool service prefix for pending batches, for example `/tools/pending`. */
  readonly toolsPath: string
  /** Django API prefix, for example `/api/v1`. */
  readonly apiPath: string
}

/** What the card can ask of the network. */
export interface ConfirmApi {
  /** The prepared batch; fails `sign-in`, `refused`, `expired` or `unavailable`. */
  loadPending(id: string): Promise<PendingView>
  /** Names and current statuses for the records (applications unless told otherwise); fails `sign-in` or `unavailable`. */
  loadSummaries(ids: readonly number[], resource?: Resource): Promise<readonly Summary[]>
  /** Staff-only files for one application; fails `sign-in` or `unavailable`. */
  loadDocuments(applicationId: number): Promise<readonly ApplicationFile[]>
  /** Same-origin URL for a validated document id and kind. */
  documentUrl(kind: ApplicationFile['kind'], id: number, mode: DocumentMode): string
  /** Use the batch up so it cannot run again: a confirm does this, and so does Cancel. */
  claim(id: string): Promise<void>
  /** Mint the 2-minute write token for exactly this action, these records and this reason. */
  mintWriteToken(spec: ActionSpec, ids: readonly number[], reason: string): Promise<string>
  /** Run one write with the write token. Never throws for an expected refusal. */
  write(spec: ActionSpec, id: number, token: string, reason: string): Promise<RecordOutcome>
}

const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json' }

async function send(options: ConfirmApiOptions, url: string, init: RequestInit): Promise<Response> {
  try {
    return await options.fetch(url, init)
  } catch {
    // The page cannot tell a network failure from a server one; both mean "try again".
    throw new ConfirmApiError('unavailable')
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    throw new ConfirmApiError('unavailable')
  }
}

function pendingView(value: unknown): PendingView {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.action !== 'string') {
    throw new ConfirmApiError('unavailable')
  }
  const { ids } = value
  const idsOk = Array.isArray(ids) && ids.length > 0 && ids.length <= 25 && ids.every(isId)
  if (!idsOk || typeof value.reason !== 'string' || typeof value.expiresAt !== 'string') {
    throw new ConfirmApiError('unavailable')
  }
  return { id: value.id, action: value.action, ids, reason: value.reason, expiresAt: value.expiresAt }
}

function applicationSummary(value: unknown): ApplicationSummary {
  if (!isRecord(value) || !isId(value.id) || !isRecord(value.program)) throw new ConfirmApiError('unavailable')
  const { name, reference, status, program } = value as Record<string, unknown> & { program: Record<string, unknown> }
  const fields = [name, reference, status, program.code, program.name]
  if (!fields.every(field => typeof field === 'string')) throw new ConfirmApiError('unavailable')
  return {
    id: value.id,
    name: name as string,
    reference: reference as string,
    status: status as string,
    program: { code: program.code as string, name: program.name as string },
  }
}

function documentSummary(value: unknown): DocumentSummary {
  if (!isRecord(value) || !isId(value.id)) throw new ConfirmApiError('unavailable')
  const { name, reference, document_type: documentType, status } = value
  if (![name, reference, documentType, status].every(field => typeof field === 'string')) {
    throw new ConfirmApiError('unavailable')
  }
  return {
    id: value.id,
    name: name as string,
    reference: reference as string,
    documentType: documentType as string,
    status: status as string,
    previewable: typeof value.previewable === 'boolean' ? value.previewable : false,
  }
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function nullableBoolean(value: unknown): value is boolean | null {
  return value === null || typeof value === 'boolean'
}

function applicationFile(value: unknown): ApplicationFile {
  if (!isRecord(value) || !isId(value.id) || (value.kind !== 'uploaded' && value.kind !== 'official')) {
    throw new ConfirmApiError('unavailable')
  }
  if (typeof value.title !== 'string' || typeof value.previewable !== 'boolean'
    || !nullableString(value.status) || !nullableBoolean(value.available_to_applicant)) {
    throw new ConfirmApiError('unavailable')
  }
  return {
    id: value.id,
    kind: value.kind,
    title: value.title,
    status: value.status,
    availableToApplicant: value.available_to_applicant,
    previewable: value.previewable,
  }
}

/** Where each resource's records are written and summarised (paths under `apiPath`). */
const WRITE_SEGMENT: Record<Resource, string> = { application: 'applications', document: 'application-documents' }
const SUMMARIES: Record<Resource, { path: string; list: string; read: (value: unknown) => Summary }> = {
  application: { path: 'application-summaries', list: 'applications', read: applicationSummary },
  document: { path: 'document-summaries', list: 'documents', read: documentSummary },
}

/** Django serves the CSRF token in the body (its cookie is HttpOnly); a session POST must echo it. */
async function csrfToken(options: ConfirmApiOptions): Promise<string> {
  const response = await send(options, `${options.apiPath}/users/csrf-token/`, { method: 'GET', headers: JSON_HEADERS })
  if (!response.ok) throw new ConfirmApiError('unavailable')
  const body = await readJson(response)
  if (!isRecord(body) || typeof body.csrfToken !== 'string') throw new ConfirmApiError('unavailable')
  return body.csrfToken
}

/** A signed-in session that has not finished 2FA is refused with 403, so 401 and 403 both mean "sign in again". */
function mintFailure(status: number): ConfirmApiError {
  if (status === 401 || status === 403) return new ConfirmApiError('sign-in')
  return new ConfirmApiError(status === 400 ? 'refused' : 'unavailable')
}

/** A refusal of a write that carries Django's own explanation (`{ "error": "..." }`). */
async function refusalDetail(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json()
    if (isRecord(body) && typeof body.error === 'string') return body.error
  } catch {
    // An unreadable body is reported as a bare refusal.
  }
  return ''
}

/**
 * Build the card's network faces.
 * @param options - the page's `fetch` and the two path prefixes.
 * @returns the faces, ready to hand to the controller.
 */
export function createConfirmApi(options: ConfirmApiOptions): ConfirmApi {
  const { toolsPath, apiPath } = options
  const pendingUrl = (id: string, suffix = ''): string => `${toolsPath}/${encodeURIComponent(id)}${suffix}`

  /** Statuses shared by the two tool-service calls. */
  const pendingFailure = (status: number): ConfirmApiError => {
    if (status === 401) return new ConfirmApiError('sign-in')
    if (status === 403) return new ConfirmApiError('refused')
    if (status === 410) return new ConfirmApiError('expired')
    return new ConfirmApiError('unavailable')
  }

  const documentPath = (kind: ApplicationFile['kind'], id: number, mode: DocumentMode): string =>
    `${apiPath}/admissions/staff/documents/${kind}/${id}/${mode}/`

  return {
    documentUrl(kind, id, mode) {
      if (!isId(id)) throw new TypeError('Invalid document id')
      return documentPath(kind, id, mode)
    },

    async loadDocuments(applicationId) {
      if (!isId(applicationId)) throw new ConfirmApiError('unavailable')
      const response = await send(options, `${apiPath}/admissions/staff/applications/${applicationId}/documents/`, {
        method: 'GET', headers: { Accept: 'application/json' },
      })
      if (response.status === 401 || response.status === 403) throw new ConfirmApiError('sign-in')
      if (!response.ok) throw new ConfirmApiError('unavailable')
      const body = await readJson(response)
      if (!isRecord(body) || !Array.isArray(body.documents)) throw new ConfirmApiError('unavailable')
      return body.documents.map(applicationFile)
    },

    async loadPending(id) {
      const response = await send(options, pendingUrl(id), { method: 'GET', headers: { Accept: 'application/json' } })
      if (!response.ok) throw pendingFailure(response.status)
      return pendingView(await readJson(response))
    },

    async loadSummaries(ids, resource = 'application') {
      const { path, list, read } = SUMMARIES[resource]
      const url = `${apiPath}/admissions/staff/${path}/?ids=${ids.join(',')}`
      const response = await send(options, url, { method: 'GET', headers: { Accept: 'application/json' } })
      if (response.status === 401 || response.status === 403) throw new ConfirmApiError('sign-in')
      if (!response.ok) throw new ConfirmApiError('unavailable')
      const body = await readJson(response)
      const rows = isRecord(body) ? body[list] : undefined
      if (!Array.isArray(rows)) throw new ConfirmApiError('unavailable')
      return rows.map(read)
    },

    async claim(id) {
      const response = await send(options, pendingUrl(id, '/consume'), { method: 'POST', headers: JSON_HEADERS })
      if (!response.ok) throw pendingFailure(response.status)
    },

    async mintWriteToken(spec, ids, reason) {
      const csrf = await csrfToken(options)
      const body: Record<string, unknown> = { kind: 'write', action: spec.action, ids }
      if (spec.reason !== 'none' && reason !== '') body.reason = reason
      const response = await send(options, `${apiPath}/ai/token/`, {
        method: 'POST',
        headers: { ...JSON_HEADERS, 'X-CSRFToken': csrf },
        body: JSON.stringify(body),
      })
      if (!response.ok) throw mintFailure(response.status)
      const minted = await readJson(response)
      if (!isRecord(minted) || typeof minted.token !== 'string') throw new ConfirmApiError('unavailable')
      return minted.token
    },

    async write(spec, id, token, reason) {
      const body = spec.reason !== 'none' && reason !== '' ? JSON.stringify({ reason }) : '{}'
      let response: Response
      try {
        response = await options.fetch(`${apiPath}/admissions/${WRITE_SEGMENT[spec.resource]}/${id}/${spec.endpoint}/`, {
          method: 'POST',
          headers: { ...JSON_HEADERS, Authorization: `Bearer ${token}` },
          body,
        })
      } catch {
        return { ok: false, kind: 'unavailable' }
      }
      if (response.ok) return { ok: true }
      if (response.status === 400) return { ok: false, kind: 'rejected', detail: await refusalDetail(response) }
      if (response.status === 404) return { ok: false, kind: 'missing' }
      if (response.status === 401 || response.status === 403) return { ok: false, kind: 'refused' }
      return { ok: false, kind: 'unavailable' }
    },
  }
}
