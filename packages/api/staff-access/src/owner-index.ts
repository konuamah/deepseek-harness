/**
 * Owner-local record of which staff user owns each Session, kept in one JSON sidecar file.
 *
 * The file is the only durable copy. A missing file is an empty index; a corrupt, wrong-version, or
 * unreadable file throws at creation, so the owner never acts on a silently empty record. Every change is
 * written atomically (temp file, fsync, rename) before the in-memory copy changes, so memory never runs
 * ahead of disk. A Session's owner also covers its descendants, up to {@link MAX_PARENT_HOPS} parent hops.
 *
 * @module @deepseek-ai/dsh-api-staff-access/src/owner-index
 */

import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'

/** Parent hops `ownerOf` walks above a Session; a Session further up never counts. */
const MAX_PARENT_HOPS = 8

/** Options for {@link createSessionOwnerIndex}. */
export interface SessionOwnerIndexOptions {
  /** JSON sidecar file path. A missing file means an empty index. */
  readonly file: string
  /** Parent Session of a child Session; undefined when the Session has no parent. */
  readonly parentOf?: (sessionId: SessionId) => SessionId | undefined
}

/** Which staff user owns each Session, with the write path that keeps the file current. */
export interface SessionOwnerIndex {
  /**
   * Record the owner of a Session that has none; recording the same owner again is a no-op.
   * @param sessionId - Session to own.
   * @param userId - Positive safe-integer Django user id.
   */
  record(sessionId: SessionId, userId: number): void
  /**
   * The owner of a Session, or of its nearest ancestor within the parent-hop cap.
   * @param sessionId - Session to look up.
   * @returns The owner's user id, or undefined when no checked Session has one.
   */
  ownerOf(sessionId: SessionId): number | undefined
  /**
   * The Sessions a user owns directly, without their descendants.
   * @param userId - Positive safe-integer Django user id.
   * @returns The owned Session ids in insertion order.
   */
  sessionsOf(userId: number): SessionId[]
  /**
   * Remove a Session's owner; a Session with no owner leaves the file untouched.
   * @param sessionId - Session whose owner is dropped.
   */
  forget(sessionId: SessionId): void
}

/**
 * Load the owner index from its sidecar file.
 * @param options - Sidecar file and optional parent lookup.
 * @returns The index, empty when the file does not exist yet.
 * @throws Error when the file is unreadable, not JSON, or not a version 1 owner document.
 */
export function createSessionOwnerIndex(options: SessionOwnerIndexOptions): SessionOwnerIndex {
  const { file, parentOf } = options
  let owners = load(file)

  function commit(next: Map<SessionId, number>): void {
    persist(file, next)
    owners = next
  }

  return {
    record(sessionId, userId) {
      assertUserId(userId)
      const current = owners.get(sessionId)
      if (current === userId) return
      if (current !== undefined) throw new Error('staff-access: session already has a different owner')
      const next = new Map(owners)
      next.set(sessionId, userId)
      commit(next)
    },
    ownerOf(sessionId) {
      let current: SessionId | undefined = sessionId
      for (let hop = 0; current !== undefined && hop <= MAX_PARENT_HOPS; hop++) {
        const owner = owners.get(current)
        if (owner !== undefined) return owner
        current = parentOf?.(current)
      }
      return undefined
    },
    sessionsOf(userId) {
      assertUserId(userId)
      return [...owners].filter(([, owner]) => owner === userId).map(([sessionId]) => sessionId)
    },
    forget(sessionId) {
      if (!owners.has(sessionId)) return
      const next = new Map(owners)
      next.delete(sessionId)
      commit(next)
    },
  }
}

/**
 * Whether a value is a user id the owner file and the API accept.
 * @param value - Candidate user id.
 * @returns True for a positive safe integer.
 */
function isUserId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/**
 * Reject a user id that is not a positive safe integer.
 * @param userId - Candidate user id.
 * @throws Error when the id is not a positive safe integer.
 */
function assertUserId(userId: unknown): asserts userId is number {
  if (!isUserId(userId)) throw new Error('staff-access: user id must be a positive safe integer')
}

/**
 * Whether a value is a plain JSON object rather than an array, null, or a scalar.
 * @param value - Candidate value.
 * @returns True for a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The error that names an owner file the index refuses to load.
 * @param file - Sidecar file path.
 * @param reason - What is wrong with the file.
 * @returns The error to throw.
 */
function ownerFileError(file: string, reason: string): Error {
  return new Error(`staff-access: owner file ${file} ${reason}`)
}

/**
 * Read and validate the owner file; a missing file is an empty index.
 * @param file - Sidecar file path.
 * @returns The owners keyed by Session id, in file order.
 * @throws Error when the file exists but cannot be read or does not validate.
 */
function load(file: string): Map<SessionId, number> {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map()
    throw error
  }
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch {
    throw ownerFileError(file, 'is not valid JSON')
  }
  if (!isRecord(document) || document['version'] !== 1) throw ownerFileError(file, 'must be version 1')
  const entries = document['owners']
  if (!isRecord(entries)) throw ownerFileError(file, 'must hold an owners object')
  const owners = new Map<SessionId, number>()
  for (const [sessionId, userId] of Object.entries(entries)) {
    if (sessionId === '' || !isUserId(userId)) throw ownerFileError(file, 'holds an invalid owner entry')
    owners.set(SessionId(sessionId), userId)
  }
  return owners
}

/**
 * Atomically replace the owner file: write a temp file in the same directory, fsync it, then rename it.
 * @param file - Sidecar file path.
 * @param owners - The complete owner set to persist.
 * @throws Error when any step fails; the temp file is removed before the error propagates.
 */
function persist(file: string, owners: ReadonlyMap<SessionId, number>): void {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`
  const body = `${JSON.stringify({ version: 1, owners: Object.fromEntries(owners) }, null, 2)}\n`
  try {
    const fd = openSync(temp, 'wx')
    try {
      writeFileSync(fd, body)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, file)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}
