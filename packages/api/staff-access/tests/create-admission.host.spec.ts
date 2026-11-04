import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import type { SessionCreateCall } from '@deepseek-ai/dsh-api-session-controller'
import { SessionId } from '@deepseek-ai/dsh-session'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as StaffAccess from '../src/plugin.ts'
import { staffPrincipal } from '../src/index.ts'

const STAFF = staffPrincipal({ userId: 1, role: 'ADMISSIONS_OFFICER' })

let dir: string
const roots: Context[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'staff-create-'))
})

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
  rmSync(dir, { recursive: true, force: true })
})

/** A Context with the remote access service and the staff plugin mounted over one owners file. */
async function setup(): Promise<Context> {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(RemoteAccessService)
  await ctx.plugin(StaffAccess, { ownersFile: join(dir, 'owners.json'), djangoBaseUrl: 'https://django.test' })
  return ctx
}

/** Run the create waterfall the way session-controller does, with the built-in create as the innermost step. */
function admit(ctx: Context, call: SessionCreateCall): Promise<void> {
  return ctx.waterfall('api-session/create-request', call, () => Promise.resolve())
}

/** A fresh create call for `principal`, whose reuse filter admits everything before the listeners narrow it. */
function createCall(principal: SessionCreateCall['principal'], request: SessionCreateCall['request'] = {}): SessionCreateCall {
  return { request, principal, reusable: () => true }
}

describe('staff create admission', () => {
  it('forces the staff preset over a requested preset', async () => {
    const ctx = await setup()
    const call = createCall(STAFF, { agentPreset: 'standard' })

    await admit(ctx, call)

    expect(call.request).toEqual({ agentPreset: 'staff' })
  })

  it.each([
    ['sessionId', { sessionId: SessionId('chosen') }],
    ['cwd', { cwd: '/etc' }],
    ['workspaceId', { workspaceId: 'workspace-1' }],
  ])('refuses a staff create that sets %s', async (_field, request) => {
    const ctx = await setup()
    const call = createCall(STAFF, request as SessionCreateCall['request'])

    await expect(admit(ctx, call)).rejects.toMatchObject({ code: 'gateway/bad-request' })
    expect(call.request).toEqual(request)
  })

  it('leaves owner creates unchanged', async () => {
    const ctx = await setup()
    const owner = createCall(undefined, { agentPreset: 'standard', cwd: '/tmp/project' })

    await admit(ctx, owner)

    expect(owner.request).toEqual({ agentPreset: 'standard', cwd: '/tmp/project' })
    expect(owner.reusable(SessionId('anything'))).toBe(true)
  })

  it('narrows the reuse filter to blank Sessions the caller owns', async () => {
    const ctx = await setup()
    ctx.staffSessions.owners.record(SessionId('mine'), 1)
    ctx.staffSessions.owners.record(SessionId('theirs'), 2)
    const call = createCall(STAFF)

    await admit(ctx, call)

    expect(call.reusable(SessionId('mine'))).toBe(true)
    expect(call.reusable(SessionId('theirs'))).toBe(false)
    expect(call.reusable(SessionId('unowned'))).toBe(false)
  })

  it('records the owner and makes the Session visible in the staff bindings', async () => {
    const ctx = await setup()
    const created = SessionId('new-session')

    await ctx.parallel('api-session/created', created, STAFF)

    expect(ctx.staffSessions.owners.ownerOf(created)).toBe(1)
    const baseline = ctx.remoteAccess.snapshotFor(STAFF)
    if (baseline.owner) throw new Error('staff snapshot must not be the owner baseline')
    expect(baseline.grants.map(grant => grant.resource)).toContainEqual({ kind: 'session', id: created })
  })

  it('fails the created event when the owner cannot be recorded', async () => {
    const ctx = await setup()
    ctx.staffSessions.owners.record(SessionId('taken'), 2)

    await expect(ctx.parallel('api-session/created', SessionId('taken'), STAFF)).rejects.toThrow()
    expect(ctx.staffSessions.owners.ownerOf(SessionId('taken'))).toBe(2)
  })

  it('does not record an owner for owner or non-staff creates', async () => {
    const ctx = await setup()

    await ctx.parallel('api-session/created', SessionId('owner-made'), undefined)

    expect(ctx.staffSessions.owners.ownerOf(SessionId('owner-made'))).toBeUndefined()
  })
})
