import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { findCookie } from '../src/django-authenticator.ts'
import { createStaffAdmission } from '../src/external-admission.ts'
import { createSessionOwnerIndex } from '../src/owner-index.ts'
import type { StaffDecision } from '../src/types.ts'

const COOKIE = 'SECRET-COOKIE-111'
const OFFICER = { kind: 'allow', identity: { userId: 1, role: 'ADMISSIONS_OFFICER' } } as const
const MANAGER = { kind: 'allow', identity: { userId: 1, role: 'ADMISSIONS_MANAGER' } } as const
const OTHER = { kind: 'allow', identity: { userId: 2, role: 'ADMISSIONS_OFFICER' } } as const
const STAFF_ONE = { kind: 'staff', userId: 1, role: 'ADMISSIONS_OFFICER' }

type Headers = Readonly<Record<string, string | string[] | undefined>>

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'staff-admission-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Fake authenticator whose answer for each cookie value the test sets. */
function fakeAuthenticator() {
  const answers = new Map<string, StaffDecision | Error>()
  const authenticate = vi.fn(async (headers: Headers): Promise<StaffDecision> => {
    const value = findCookie(headers.cookie, 'sessionid')
    const answer = value === undefined ? undefined : answers.get(value)
    if (answer instanceof Error) throw answer
    return answer ?? { kind: 'deny', reason: 'no-cookie' }
  })
  const invalidateUser = vi.fn()
  return { answers, authenticate, invalidateUser }
}

/** Fake Host services: agents by Session id, the Connection, Remote access, and the logger. */
function fakeScope() {
  const agents = new Map<SessionId, { cancel: ReturnType<typeof vi.fn> }>()
  const scope = {
    agents: { get: (id: SessionId) => agents.get(id) },
    connection: { disposeExternalPeer: vi.fn() },
    remoteAccess: { invalidate: vi.fn() },
    logger: { warn: vi.fn(), error: vi.fn() },
  }
  return { agents, scope }
}

function setup() {
  const auth = fakeAuthenticator()
  const owners = createSessionOwnerIndex({ file: join(dir, 'owners.json') })
  const { agents, scope } = fakeScope()
  const admission = createStaffAdmission({
    authenticator: auth,
    cookieName: 'sessionid',
    owners,
    scope: scope as never,
  })
  return { auth, owners, agents, scope, admission }
}

function headers(value: string = COOKIE): Headers {
  return { cookie: `sessionid=${value}` }
}

/** Everything the logger was given, flattened to text, for the cookie leak check. */
function loggedText(scope: ReturnType<typeof fakeScope>['scope']): string {
  return JSON.stringify([scope.logger.warn.mock.calls, scope.logger.error.mock.calls])
}

describe('staff admission', () => {
  it('admits an allowed cookie as the staff key and principal', async () => {
    const { auth, admission } = setup()
    auth.answers.set(COOKIE, OFFICER)
    expect(await admission.admit(headers())).toEqual({ kind: 'allow', key: 'staff:1', principal: STAFF_ONE })
  })

  it('denies without calling Django when the cookie is missing', async () => {
    const { auth, admission } = setup()
    expect(await admission.admit({})).toEqual({ kind: 'deny' })
    expect(auth.authenticate).not.toHaveBeenCalled()
  })

  it('denies a refused cookie and does not throw', async () => {
    const { auth, admission } = setup()
    auth.answers.set(COOKIE, { kind: 'deny', reason: 'rejected' })
    expect(await admission.admit(headers())).toEqual({ kind: 'deny' })
  })

  it('denies when the authenticator throws, without logging the cookie', async () => {
    const { auth, admission, scope } = setup()
    auth.answers.set(COOKIE, new Error(`upstream said ${COOKIE}`))
    expect(await admission.admit(headers())).toEqual({ kind: 'deny' })
    expect(loggedText(scope)).not.toContain(COOKIE)
  })

  it('denies every request after dispose', async () => {
    const { auth, admission } = setup()
    auth.answers.set(COOKIE, OFFICER)
    admission.dispose()
    expect(await admission.admit(headers())).toEqual({ kind: 'deny' })
  })

  it('revokes the held user when a request for the same cookie is denied', async () => {
    const { auth, admission, scope } = setup()
    auth.answers.set(COOKIE, OFFICER)
    await admission.admit(headers())
    auth.answers.set(COOKIE, { kind: 'deny', reason: 'rejected' })
    expect(await admission.admit(headers())).toEqual({ kind: 'deny' })
    expect(scope.connection.disposeExternalPeer).toHaveBeenCalledWith('staff:1')
    expect(scope.remoteAccess.invalidate).toHaveBeenCalledWith(STAFF_ONE)
  })

  it('revokes the earlier user and admits fresh when the cookie now belongs to another user', async () => {
    const { auth, admission, scope } = setup()
    auth.answers.set(COOKIE, OFFICER)
    await admission.admit(headers())
    auth.answers.set(COOKIE, OTHER)
    expect(await admission.admit(headers())).toEqual({
      kind: 'allow',
      key: 'staff:2',
      principal: { kind: 'staff', userId: 2, role: 'ADMISSIONS_OFFICER' },
    })
    expect(scope.connection.disposeExternalPeer).toHaveBeenCalledWith('staff:1')
    expect(scope.connection.disposeExternalPeer).not.toHaveBeenCalledWith('staff:2')
  })

  it('revokes and admits fresh when the role changes for the same user', async () => {
    const { auth, admission, scope } = setup()
    auth.answers.set(COOKIE, OFFICER)
    await admission.admit(headers())
    auth.answers.set(COOKIE, MANAGER)
    expect(await admission.admit(headers())).toEqual({
      kind: 'allow',
      key: 'staff:1',
      principal: { kind: 'staff', userId: 1, role: 'ADMISSIONS_MANAGER' },
    })
    expect(scope.connection.disposeExternalPeer).toHaveBeenCalledTimes(1)
    expect(scope.connection.disposeExternalPeer).toHaveBeenCalledWith('staff:1')
  })

  it('revokes the least recently admitted user when more than 1000 are held', async () => {
    const { auth, admission, scope } = setup()
    for (let id = 1; id <= 1001; id++) {
      const value = `cookie-${id}`
      auth.answers.set(value, { kind: 'allow', identity: { userId: id, role: 'ADMISSIONS_OFFICER' } })
      await admission.admit(headers(value))
    }
    expect(scope.connection.disposeExternalPeer).toHaveBeenCalledTimes(1)
    expect(scope.connection.disposeExternalPeer).toHaveBeenCalledWith('staff:1')
  })
})

describe('staff revocation', () => {
  it('cancels only the revoked user running turns with the command cancel arguments', async () => {
    const { auth, owners, agents, admission } = setup()
    const mine = SessionId('mine')
    const theirs = SessionId('theirs')
    owners.record(mine, 1)
    owners.record(theirs, 2)
    const myCancel = vi.fn()
    const theirCancel = vi.fn()
    agents.set(mine, { cancel: myCancel })
    agents.set(theirs, { cancel: theirCancel })
    auth.answers.set(COOKIE, OFFICER)
    await admission.admit(headers())
    admission.revokeStaff(1)
    expect(myCancel).toHaveBeenCalledWith({ kind: 'user' }, { keepInbox: true })
    expect(theirCancel).not.toHaveBeenCalled()
  })

  it('disposes only the revoked Peer and invalidates only its principal', async () => {
    const { auth, admission, scope } = setup()
    auth.answers.set(COOKIE, OFFICER)
    await admission.admit(headers())
    admission.revokeStaff(1)
    expect(scope.connection.disposeExternalPeer).toHaveBeenCalledWith('staff:1')
    expect(scope.remoteAccess.invalidate).toHaveBeenCalledWith(STAFF_ONE)
    expect(scope.remoteAccess.invalidate).toHaveBeenCalledTimes(1)
  })

  it('is idempotent', async () => {
    const { auth, admission } = setup()
    auth.answers.set(COOKIE, OFFICER)
    await admission.admit(headers())
    admission.revokeStaff(1)
    expect(() => { admission.revokeStaff(1) }).not.toThrow()
  })

  it('finishes the remaining steps when one throws, reports it, and forgets the cookie', async () => {
    const { auth, owners, agents, admission, scope } = setup()
    const failing = SessionId('failing')
    owners.record(failing, 1)
    agents.set(failing, { cancel: vi.fn(() => { throw new Error('cancel refused') }) })
    scope.connection.disposeExternalPeer.mockImplementation(() => { throw new Error('dispose refused') })
    auth.answers.set(COOKIE, OFFICER)
    await admission.admit(headers())
    expect(() => { admission.revokeStaff(1) }).toThrow(AggregateError)
    expect(scope.connection.disposeExternalPeer).toHaveBeenCalledWith('staff:1')
    expect(scope.remoteAccess.invalidate).toHaveBeenCalledWith(STAFF_ONE)
    await admission.sweep()
    expect(auth.authenticate).toHaveBeenCalledTimes(1)
  })

  it('logs a failed revoke as an error that names the user and omits the cookie', async () => {
    const { auth, admission, scope } = setup()
    scope.connection.disposeExternalPeer.mockImplementation(() => { throw new Error(`bad ${COOKIE}`) })
    auth.answers.set(COOKIE, OFFICER)
    await admission.admit(headers())
    auth.answers.set(COOKIE, { kind: 'deny', reason: 'rejected' })
    await admission.admit(headers())
    expect(scope.logger.error).toHaveBeenCalledTimes(1)
    const message = String(scope.logger.error.mock.calls[0]?.[0])
    expect(message).toContain('staff user 1')
    expect(message).toContain('[redacted]')
    expect(loggedText(scope)).not.toContain(COOKIE)
  })
})

describe('staff revocation sweep', () => {
  it('re-checks each held cookie after invalidating its cached decision', async () => {
    const { auth, admission, scope } = setup()
    auth.answers.set(COOKIE, OFFICER)
    await admission.admit(headers())
    await admission.sweep()
    expect(auth.invalidateUser).toHaveBeenCalledWith(1)
    expect(auth.authenticate).toHaveBeenLastCalledWith({ cookie: `sessionid=${COOKIE}` })
    expect(scope.connection.disposeExternalPeer).not.toHaveBeenCalled()
  })

  it.each<[string, StaffDecision]>([
    ['a Django denial', { kind: 'deny', reason: 'rejected' }],
    ['a two-factor step still open', { kind: 'deny', reason: 'two-factor' }],
    ['a non-admissions role', { kind: 'deny', reason: 'wrong-role' }],
    ['a Django failure, which fails closed', { kind: 'deny', reason: 'unavailable' }],
  ])('revokes when the re-check reports %s', async (_label, answer) => {
    const { auth, admission, scope } = setup()
    auth.answers.set(COOKIE, OFFICER)
    await admission.admit(headers())
    auth.answers.set(COOKIE, answer)
    await admission.sweep()
    expect(scope.connection.disposeExternalPeer).toHaveBeenCalledWith('staff:1')
    expect(scope.remoteAccess.invalidate).toHaveBeenCalledWith(STAFF_ONE)
  })

  it('revokes when the re-check throws', async () => {
    const { auth, admission, scope } = setup()
    auth.answers.set(COOKIE, OFFICER)
    await admission.admit(headers())
    auth.answers.set(COOKIE, new Error('unexpected'))
    await admission.sweep()
    expect(scope.connection.disposeExternalPeer).toHaveBeenCalledWith('staff:1')
  })

  it('revokes and admits fresh when the re-check changes the role', async () => {
    const { auth, admission, scope } = setup()
    auth.answers.set(COOKIE, OFFICER)
    await admission.admit(headers())
    auth.answers.set(COOKIE, MANAGER)
    await admission.sweep()
    expect(scope.connection.disposeExternalPeer).toHaveBeenCalledWith('staff:1')
    auth.authenticate.mockClear()
    await admission.sweep()
    expect(auth.authenticate).toHaveBeenCalledTimes(1)
    expect(scope.connection.disposeExternalPeer).toHaveBeenCalledTimes(1)
  })

  it('never calls Django when no cookie is held', async () => {
    const { auth, admission } = setup()
    await admission.sweep()
    expect(auth.authenticate).not.toHaveBeenCalled()
    expect(auth.invalidateUser).not.toHaveBeenCalled()
  })

  it('does not call Django again for a user revoked by a sweep', async () => {
    const { auth, admission } = setup()
    auth.answers.set(COOKIE, OFFICER)
    await admission.admit(headers())
    auth.answers.set(COOKIE, { kind: 'deny', reason: 'rejected' })
    await admission.sweep()
    auth.authenticate.mockClear()
    await admission.sweep()
    expect(auth.authenticate).not.toHaveBeenCalled()
  })
})
