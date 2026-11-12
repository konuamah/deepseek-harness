/**
 * Fail-closed decoding for the two things this backend reads from durable
 * text columns: a Session header and one event record. Both are lossless JSON
 * text, so escaped NUL and other unusual characters survive.
 * @module @deepseek-ai/dsh-session-persistence-postgres/codec
 */

import type { SessionEvent, SessionHeader, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { SessionLogOffset as makeSessionLogOffset } from '@deepseek-ai/dsh-session'
import {
  SessionPersistenceCorruptionError,
  assertStoredId,
  assertVersion,
  materializeCreateHeader,
  type SessionPersistenceCreateOptions,
} from '@deepseek-ai/dsh-session-persistence'

/** Whether a value is a plain object rather than an array, null, or a scalar. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Refuse stored bytes a caller could not have produced through this seam. */
export function corruption(id: SessionId, what: string, cause?: unknown): SessionPersistenceCorruptionError {
  return new SessionPersistenceCorruptionError(`stored session "${id}" has an invalid ${what}`, { cause })
}

const optionalString = (value: unknown): boolean => value === undefined || typeof value === 'string'
const optionalDepth = (value: unknown): boolean => value === undefined
  || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)

/** Whether the four mandatory header fields have their exact types. */
function hasRequiredHeaderFields(value: Record<string, unknown>): boolean {
  return typeof value['version'] === 'number'
    && typeof value['id'] === 'string'
    && typeof value['createdAt'] === 'number'
    && typeof value['isSeeded'] === 'boolean'
}

/** Whether a decoded value has exactly the field types a Session header accepts. */
function isHeaderRecord(value: unknown): value is SessionHeader {
  if (!isRecord(value) || !hasRequiredHeaderFields(value)) return false
  return optionalString(value['cwd'])
    && optionalString(value['parentSession'])
    && optionalString(value['agentPreset'])
    && (value['origin'] === undefined || value['origin'] === 'subagent')
    && optionalDepth(value['delegationDepth'])
}

/** Decode one stored header, refusing a foreign identity, version, or field type. */
export function decodeHeader(id: SessionId, text: string): SessionHeader {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error: unknown) {
    throw corruption(id, 'header', error)
  }
  if (!isHeaderRecord(value)) throw corruption(id, 'header')
  const header = materializeCreateHeader(value)
  assertStoredId(id, header)
  assertVersion(header)
  return header
}

/** Whether a decoded value has the envelope fields every stored event carries. */
function isEventRecord(value: unknown, seq: number): value is SessionEvent {
  return isRecord(value)
    && typeof value['type'] === 'string'
    && value['seq'] === seq
    && typeof value['time'] === 'number'
}

/** Decode one stored event row, refusing a record the seam could not produce. */
export function decodeEvent(id: SessionId, seq: number, payload: string): SessionEvent {
  let value: unknown
  try {
    value = JSON.parse(payload)
  } catch (error: unknown) {
    throw corruption(id, `event at seq ${seq}`, error)
  }
  if (!isEventRecord(value, seq)) throw corruption(id, `event at seq ${seq}`)
  return value
}

/** Whether an error is a Postgres unique violation. */
export function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505'
}

/** Validate the seeded/cut pair exactly as the storage seam requires. */
export function resolveInherited(header: SessionHeader, options?: SessionPersistenceCreateOptions): SessionLogOffset {
  const inherited = makeSessionLogOffset(options?.inheritedEventCount ?? 0)
  if (header.isSeeded && options?.inheritedEventCount === undefined) {
    throw new Error('seeded session header requires an inherited event count')
  }
  if (!header.isSeeded && inherited !== 0) {
    throw new Error('unseeded session header inherited event count must be 0')
  }
  return inherited
}
