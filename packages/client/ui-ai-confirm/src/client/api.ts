/**
 * The card's two network faces, both on the page's own origin: the tool service (the pending batch)
 * and Django (names, the write token, the writes). Every failure becomes one of four kinds the card
 * can explain; no response text from either side is shown except Django's own refusal of a write.
 * The module takes `fetch` as a parameter, so tests drive it without a network.
 */
import { isId, isRecord, type ActionSpec } from './model.ts'

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
  /** Names and current statuses for the records; fails `sign-in` or `unavailable`. */
  loadSummaries(ids: readonly number[]): Promise<readonly ApplicationSummary[]>
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

  return {
    async loadPending(id) {
      const response = await send(options, pendingUrl(id), { method: 'GET', headers: { Accept: 'application/json' } })
      if (!response.ok) throw pendingFailure(response.status)
      return pendingView(await readJson(response))
    },

    async loadSummaries(ids) {
      const url = `${apiPath}/admissions/staff/application-summaries/?ids=${ids.join(',')}`
      const response = await send(options, url, { method: 'GET', headers: { Accept: 'application/json' } })
      if (response.status === 401 || response.status === 403) throw new ConfirmApiError('sign-in')
      if (!response.ok) throw new ConfirmApiError('unavailable')
      const body = await readJson(response)
      if (!isRecord(body) || !Array.isArray(body.applications)) throw new ConfirmApiError('unavailable')
      return body.applications.map(applicationSummary)
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
        response = await options.fetch(`${apiPath}/admissions/applications/${id}/${spec.endpoint}/`, {
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
