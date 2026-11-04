import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSessionOwnerIndex, type SessionOwnerIndexOptions } from '../src/index.ts'

const OWNER_ERROR = 'staff-access: owner file'
const ID_ERROR = 'staff-access: user id must be a positive safe integer'
const A = SessionId('a')
const B = SessionId('b')
const C = SessionId('c')

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'staff-owners-'))
  file = join(dir, 'owners.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeOwners(body: string): void {
  writeFileSync(file, body)
}

function tempFiles(): string[] {
  return readdirSync(dir).filter(name => name.endsWith('.tmp'))
}

/** A parent lookup over an explicit child-to-parent map. */
function parentsFrom(pairs: readonly (readonly [SessionId, SessionId])[]): NonNullable<SessionOwnerIndexOptions['parentOf']> {
  const parents = new Map<SessionId, SessionId>(pairs)
  return sessionId => parents.get(sessionId)
}

describe('createSessionOwnerIndex loading', () => {
  it('loads a valid version 1 file and answers ownerOf and sessionsOf', () => {
    writeOwners(JSON.stringify({ version: 1, owners: { a: 1, b: 2 } }))
    const index = createSessionOwnerIndex({ file })
    expect(index.ownerOf(A)).toBe(1)
    expect(index.ownerOf(B)).toBe(2)
    expect(index.sessionsOf(2)).toEqual([B])
  })

  it('treats a missing file as an empty index and creates the file on the first record', () => {
    const index = createSessionOwnerIndex({ file })
    expect(index.ownerOf(A)).toBeUndefined()
    expect(index.sessionsOf(1)).toEqual([])
    expect(existsSync(file)).toBe(false)
    index.record(A, 1)
    expect(existsSync(file)).toBe(true)
  })

  it('refuses corrupt, wrong-version, and malformed documents', () => {
    const bad = [
      '{not json',
      JSON.stringify({ version: 2, owners: {} }),
      JSON.stringify({ owners: {} }),
      JSON.stringify({ version: 1, owners: [] }),
      JSON.stringify({ version: 1 }),
      JSON.stringify({ version: 1, owners: { a: 1.5 } }),
      JSON.stringify({ version: 1, owners: { a: '7' } }),
      JSON.stringify({ version: 1, owners: { a: 0 } }),
      JSON.stringify({ version: 1, owners: { '': 1 } }),
      'null',
      '"text"',
      '[]',
    ]
    for (const body of bad) {
      writeOwners(body)
      expect(() => createSessionOwnerIndex({ file }), body).toThrow(OWNER_ERROR)
    }
  })

  it('rethrows a read error other than a missing file', () => {
    mkdirSync(file)
    expect(() => createSessionOwnerIndex({ file })).toThrow(/EISDIR/)
  })
})

describe('createSessionOwnerIndex writes', () => {
  it('writes the exact canonical document and leaves no temp file behind', () => {
    const index = createSessionOwnerIndex({ file })
    index.record(A, 1)
    index.record(B, 2)
    expect(readFileSync(file, 'utf8')).toBe(`${JSON.stringify({ version: 1, owners: { a: 1, b: 2 } }, null, 2)}\n`)
    expect(tempFiles()).toEqual([])
  })

  it('keeps every record across a restart', () => {
    createSessionOwnerIndex({ file }).record(A, 7)
    const restarted = createSessionOwnerIndex({ file })
    expect(restarted.ownerOf(A)).toBe(7)
  })

  it('refuses to reassign an owner and writes nothing', () => {
    const index = createSessionOwnerIndex({ file })
    index.record(A, 1)
    const before = readFileSync(file, 'utf8')
    expect(() => { index.record(A, 2) }).toThrow('staff-access: session already has a different owner')
    expect(index.ownerOf(A)).toBe(1)
    expect(readFileSync(file, 'utf8')).toBe(before)
  })

  it('treats recording the same owner again as a no-op', () => {
    const index = createSessionOwnerIndex({ file })
    index.record(A, 1)
    const before = readFileSync(file, 'utf8')
    index.record(A, 1)
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(index.sessionsOf(1)).toEqual([A])
  })

  it('rejects user ids that are not positive safe integers', () => {
    const index = createSessionOwnerIndex({ file })
    for (const userId of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => { index.record(A, userId) }).toThrow(ID_ERROR)
    }
    expect(() => { index.sessionsOf(0) }).toThrow(ID_ERROR)
    expect(() => { index.sessionsOf(1.5) }).toThrow(ID_ERROR)
    expect(index.ownerOf(A)).toBeUndefined()
  })

  it('leaves memory unchanged and removes the temp file when the write fails', () => {
    const index = createSessionOwnerIndex({ file })
    mkdirSync(file)
    expect(() => { index.record(A, 1) }).toThrow()
    expect(tempFiles()).toEqual([])
    expect(index.ownerOf(A)).toBeUndefined()
  })

  it('forgets a recorded session and persists the removal', () => {
    const index = createSessionOwnerIndex({ file })
    index.record(A, 1)
    index.record(B, 1)
    index.forget(A)
    expect(index.ownerOf(A)).toBeUndefined()
    expect(readFileSync(file, 'utf8')).toBe(`${JSON.stringify({ version: 1, owners: { b: 1 } }, null, 2)}\n`)
  })

  it('does not write when forgetting an unknown session', () => {
    const index = createSessionOwnerIndex({ file })
    index.record(A, 1)
    const past = new Date(1_000_000_000_000)
    utimesSync(file, past, past)
    index.forget(C)
    expect(statSync(file).mtimeMs).toBe(past.getTime())
  })
})

describe('createSessionOwnerIndex ancestry', () => {
  it('lets a child inherit the owner of its parent', () => {
    const index = createSessionOwnerIndex({ file, parentOf: parentsFrom([[B, A]]) })
    index.record(A, 5)
    expect(index.ownerOf(B)).toBe(5)
  })

  it('finds the owner at the eighth ancestor and never at the ninth', () => {
    const at = (depth: number): SessionId => SessionId(`n${depth}`)
    const index = createSessionOwnerIndex({ file, parentOf: sessionId => at(Number(sessionId.slice(1)) + 1) })
    index.record(at(8), 3)
    expect(index.ownerOf(at(0))).toBe(3)
    index.forget(at(8))
    index.record(at(9), 4)
    expect(index.ownerOf(at(0))).toBeUndefined()
  })

  it('checks only the session itself when no parent lookup is given', () => {
    const index = createSessionOwnerIndex({ file })
    index.record(A, 1)
    expect(index.ownerOf(B)).toBeUndefined()
    expect(index.ownerOf(A)).toBe(1)
  })

  it('lists only the directly owned sessions of a user', () => {
    const index = createSessionOwnerIndex({ file, parentOf: parentsFrom([[B, A]]) })
    index.record(A, 1)
    expect(index.sessionsOf(1)).toEqual([A])
    expect(index.sessionsOf(9)).toEqual([])
  })
})
