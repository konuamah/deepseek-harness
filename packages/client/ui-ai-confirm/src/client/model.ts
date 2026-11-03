/**
 * What the confirm card understands about a prepared batch: the three prepare tools, the batch the
 * tool service describes in its result text, and the display keys for application statuses.
 * Pure data and validation; nothing here reads the Session, the network or the DOM.
 */

/** How a prepare tool treats the reason text. */
export type ReasonRule = 'none' | 'optional' | 'required'

/** One prepare tool and the Django write it stands for. */
export interface ActionSpec {
  /** Tool name without the `mcp__<server>__` prefix. */
  readonly tool: string
  /** Action id Django's write token is minted for. */
  readonly action: string
  /** Last path segment of the Django write call: `/applications/<id>/<endpoint>/`. */
  readonly endpoint: string
  /** Locale key prefix for this action's copy. */
  readonly copy: 'approve' | 'reject' | 'requestDocuments'
  readonly reason: ReasonRule
}

/** The three prepare tools, in the order the tool service lists them. */
export const ACTIONS: readonly ActionSpec[] = [
  { tool: 'prepare_approve', action: 'application.approve', endpoint: 'approve', copy: 'approve', reason: 'none' },
  { tool: 'prepare_reject', action: 'application.reject', endpoint: 'reject', copy: 'reject', reason: 'optional' },
  {
    tool: 'prepare_request_documents',
    action: 'application.request_documents',
    endpoint: 'request_documents',
    copy: 'requestDocuments',
    reason: 'required',
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

/** The status a successful write leaves the application in. */
const RESULT_STATUS: Readonly<Record<string, string>> = {
  'application.approve': 'APPROVED',
  'application.reject': 'REJECTED',
  'application.request_documents': 'DOCUMENTS_REQUIRED',
}

/**
 * Status an action is expected to leave a record in, for the before/after line.
 * @param action - the Django action id.
 * @returns the status string, or undefined for an unknown action.
 */
export function statusAfter(action: string): string | undefined {
  return RESULT_STATUS[action]
}
