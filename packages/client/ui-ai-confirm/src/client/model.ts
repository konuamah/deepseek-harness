/**
 * What the confirm card understands about a prepared batch: the prepare tools, the batch the
 * tool service describes in its result text, and the display keys for application statuses.
 * Pure data and validation; nothing here reads the Session, the network or the DOM.
 */

/** How a prepare tool treats the reason text. */
export type ReasonRule = 'none' | 'optional' | 'required'

/** What a prepared batch is made of: applications, or the documents of applications. */
export type Resource = 'application' | 'document'

/** One prepare tool and the Django write it stands for. */
export interface ActionSpec {
  /** Tool name without the `mcp__<server>__` prefix. */
  readonly tool: string
  /** Action id Django's write token is minted for. */
  readonly action: string
  /** What the batch's ids are; picks the write path and the staff summaries call. */
  readonly resource: Resource
  /** Last path segment of the Django write call: `/<applications|application-documents>/<id>/<endpoint>/`. */
  readonly endpoint: string
  /** Locale key prefix for this action's copy. */
  readonly copy: 'approve' | 'reject' | 'requestDocuments' | 'cancel' | 'verifyDocument' | 'rejectDocument' | 'enroll' | 'sendOffer'
  readonly reason: ReasonRule
  /** Staff must also retype the application reference; Django checks it too. */
  readonly confirmReference?: boolean
}

/** The prepare tools, in the order the tool service lists them. */
export const ACTIONS: readonly ActionSpec[] = [
  {
    tool: 'prepare_approve', action: 'application.approve', resource: 'application',
    endpoint: 'approve', copy: 'approve', reason: 'none',
  },
  {
    tool: 'prepare_reject', action: 'application.reject', resource: 'application',
    endpoint: 'reject', copy: 'reject', reason: 'optional',
  },
  {
    tool: 'prepare_request_documents',
    action: 'application.request_documents',
    resource: 'application',
    endpoint: 'request_documents',
    copy: 'requestDocuments',
    reason: 'required',
  },
  {
    tool: 'prepare_cancel', action: 'application.cancel', resource: 'application',
    endpoint: 'cancel', copy: 'cancel', reason: 'none',
  },
  {
    tool: 'prepare_verify_document', action: 'application_document.verify', resource: 'document',
    endpoint: 'verify', copy: 'verifyDocument', reason: 'none',
  },
  {
    tool: 'prepare_reject_document', action: 'application_document.reject', resource: 'document',
    endpoint: 'reject_document', copy: 'rejectDocument', reason: 'required',
  },
  {
    tool: 'prepare_enroll', action: 'application.enroll', resource: 'application',
    endpoint: 'enroll', copy: 'enroll', reason: 'required', confirmReference: true,
  },
  {
    tool: 'prepare_send_offer', action: 'offer.send', resource: 'application',
    endpoint: 'send_offer', copy: 'sendOffer', reason: 'none', confirmReference: true,
  },
]

/** Longest reason Django accepts when minting a write token. */
export const MAX_REASON_LENGTH = 500

/**
 * The wire name the harness gives an MCP tool: `mcp__<serverName>__<tool>`.
 * @param serverName - the `serverName` of the MCP entry that connects the tool service.
 * @param spec - the prepare tool.
 * @returns the key to register the card under.
 */
export function wireName(serverName: string, spec: ActionSpec): string {
  return `mcp__${serverName}__${spec.tool}`
}

/** One record the tool service accepted for the batch. */
export interface EligibleRecord {
  readonly id: number
  /** Status at preparation time. */
  readonly status: string
}

/** One record the tool service left out, with its reason in the tool service's words. */
export interface SkippedRecord {
  readonly id: number
  readonly status: string | null
  readonly why: string
}

/** The result of a prepare tool call. */
export interface PreparedBatch {
  readonly pendingActionId: string
  readonly action: string
  readonly eligible: readonly EligibleRecord[]
  readonly skipped: readonly SkippedRecord[]
  readonly expiresAt: string
}

const BATCH_LIMIT = 25
const PENDING_ID = /^[0-9a-f-]{36}$/i

/**
 * Narrow wire data to a plain object.
 * @param value - parsed JSON.
 * @returns whether it is an object and not an array or null.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Narrow wire data to an application id.
 * @param value - parsed JSON.
 * @returns whether it is a positive integer.
 */
export function isId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function eligibleRecord(value: unknown): EligibleRecord | null {
  if (!isRecord(value) || !isId(value.id) || typeof value.status !== 'string') return null
  return { id: value.id, status: value.status }
}

function skippedRecord(value: unknown): SkippedRecord | null {
  if (!isRecord(value) || !isId(value.id) || typeof value.why !== 'string') return null
  if (value.status !== null && typeof value.status !== 'string') return null
  return { id: value.id, status: value.status, why: value.why }
}

function parseList<T>(value: unknown, read: (item: unknown) => T | null, min: number): readonly T[] | null {
  if (!Array.isArray(value) || value.length < min || value.length > BATCH_LIMIT) return null
  const records = value.map(read)
  return records.every((record): record is T => record !== null) ? records : null
}

/**
 * Read the batch out of a prepare tool's result text. The text is wire data from a tool, so every
 * field is checked and anything else yields null (the card then shows the plain result text).
 * @param text - the tool result's text content.
 * @returns the batch, or null when the text is not a well-formed batch.
 */
export function parsePrepared(text: string): PreparedBatch | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(value) || typeof value.pendingActionId !== 'string' || !PENDING_ID.test(value.pendingActionId)) {
    return null
  }
  if (typeof value.action !== 'string' || typeof value.expiresAt !== 'string') return null
  const eligible = parseList(value.eligible, eligibleRecord, 1)
  const skipped = parseList(value.skipped, skippedRecord, 0)
  if (eligible === null || skipped === null) return null
  return { pendingActionId: value.pendingActionId, action: value.action, eligible, skipped, expiresAt: value.expiresAt }
}

/** The tools whose results list applications; the read cards register for these. */
export const READ_TOOLS = ['list_applications', 'get_application'] as const

/**
 * The wire name of a read tool: `mcp__<serverName>__<tool>`.
 * @param serverName - the `serverName` of the MCP entry that connects the tool service.
 * @param tool - the read tool.
 * @returns the key to register the card under.
 */
export function readWireName(serverName: string, tool: (typeof READ_TOOLS)[number]): string {
  return `mcp__${serverName}__${tool}`
}

/** Fixed fields used from each read result; the browser loads display names separately. */
export interface ListedApplication {
  readonly id: number
  readonly reference: string
  readonly status: string
  readonly program: string
}

function listedApplication(value: unknown): ListedApplication | null {
  if (!isRecord(value) || !isId(value.id) || typeof value.reference !== 'string' || typeof value.status !== 'string') {
    return null
  }
  if (!isRecord(value.program) || typeof value.program.name !== 'string') return null
  return { id: value.id, reference: value.reference, status: value.status, program: value.program.name }
}

/**
 * Read the applications out of `list_applications` (an `applications` array) or `get_application`
 * (one application at the top level). Wire data: anything malformed, empty or too long yields null.
 * @param text - the tool result's text content.
 * @returns the applications, or null.
 */
export function parseApplications(text: string): readonly ListedApplication[] | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(value)) return null
  const items = Array.isArray(value.applications) ? value.applications : [value]
  if (items.length === 0 || items.length > BATCH_LIMIT) return null
  const rows = items.map(listedApplication)
  return rows.every((row): row is ListedApplication => row !== null) ? rows : null
}

/**
 * Application ids a staff card shows: a read result's applications, or a prepare call's application
 * ids. Document batches name their applications in the call (`documents[].applicationId`), not in
 * the batch's document ids, so prepare ids come from the call arguments.
 * @param toolName - the wire tool name.
 * @param args - the prepare call's JSON arguments; unused for reads.
 * @param text - the read result's text.
 * @returns the application ids, deduplicated for document batches; empty when unavailable.
 */
export function shownApplicationIds(toolName: string, args: string | undefined, text: string): readonly number[] {
  const name = toolName.split('__').at(-1)
  if (name === 'list_applications' || name === 'get_application') {
    return parseApplications(text)?.map(row => row.id) ?? []
  }
  if (args === undefined) return []
  let value: unknown
  try {
    value = JSON.parse(args)
  } catch {
    return []
  }
  if (!isRecord(value)) return []
  if (isId(value.id)) return [value.id]
  if (Array.isArray(value.ids)) return value.ids.filter(isId)
  if (Array.isArray(value.documents)) {
    const ids = new Set<number>()
    for (const pair of value.documents) {
      if (isRecord(pair) && isId(pair.applicationId)) ids.add(pair.applicationId)
    }
    return [...ids]
  }
  return []
}

/** Application statuses the card has a label for. */
const STATUS_KEYS = {
  DRAFT: 'status.draft',
  PENDING: 'status.pending',
  UNDER_REVIEW: 'status.underReview',
  DOCUMENTS_REQUIRED: 'status.documentsRequired',
  APPROVED: 'status.approved',
  PAYMENT_PENDING: 'status.paymentPending',
  ENROLLED: 'status.enrolled',
  REJECTED: 'status.rejected',
  WITHDRAWN: 'status.withdrawn',
  CANCELLED: 'status.cancelled',
  VERIFIED: 'status.verified',
} as const

/** Locale key of a known application status. */
export type StatusKey = (typeof STATUS_KEYS)[keyof typeof STATUS_KEYS]

/**
 * Locale key for a status from the wire.
 * @param status - the status string.
 * @returns the key, or undefined for a status this card does not know (shown verbatim).
 */
export function statusKey(status: string): StatusKey | undefined {
  return Object.hasOwn(STATUS_KEYS, status) ? STATUS_KEYS[status as keyof typeof STATUS_KEYS] : undefined
}

/** The status a successful write leaves the record in. */
const RESULT_STATUS: Readonly<Record<string, string>> = {
  'application.approve': 'APPROVED',
  'application.reject': 'REJECTED',
  'application.request_documents': 'DOCUMENTS_REQUIRED',
  'application.cancel': 'CANCELLED',
  'application.enroll': 'ENROLLED',
  'application_document.verify': 'VERIFIED',
  'application_document.reject': 'REJECTED',
}

/**
 * Status an action is expected to leave a record in, for the before/after line.
 * @param action - the Django action id.
 * @returns the status string, or undefined for an unknown action.
 */
export function statusAfter(action: string): string | undefined {
  return RESULT_STATUS[action]
}

/**
 * A name that is safe to show: staff summaries fall back to the login email when an account has no
 * name, so an empty name or one holding `@` is never shown.
 * @param name - the name from the staff call.
 * @returns the name, or undefined when it must not be shown.
 */
export function shownName(name: string): string | undefined {
  return name.trim() !== '' && !name.includes('@') ? name : undefined
}
