import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import type { SessionCreateCall } from '@deepseek-ai/dsh-api-session-controller'
import type { PostgresOwnershipService } from '@deepseek-ai/dsh-session-persistence-postgres'
import { SessionId } from '@deepseek-ai/dsh-session'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as StaffAccess from '../src/plugin.ts'
import { provideWorkspaceRegistry, SHARED_WORKSPACE_ID, settle } from './workspace-registry-stub.ts'
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
  provideWorkspaceRegistry(ctx)
  await ctx.plugin(StaffAccess, { ownersFile: join(dir, 'owners.json'), djangoBaseUrl: 'https://django.test', workspaceDir: join(dir, 'workspace') })
  await settle()
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

    expect(call.request).toEqual({ agentPreset: 'staff', workspaceId: SHARED_WORKSPACE_ID })
  })

  it('places a staff create without workspaceId in the shared Workspace', async () => {
    const ctx = await setup()
    const call = createCall(STAFF)

    await admit(ctx, call)

    expect(call.request).toEqual({ agentPreset: 'staff', workspaceId: SHARED_WORKSPACE_ID })
  })

  it('accepts a staff create that names the shared Workspace', async () => {
    const ctx = await setup()
    const call = createCall(STAFF, { workspaceId: SHARED_WORKSPACE_ID })

    await admit(ctx, call)

    expect(call.request).toEqual({ agentPreset: 'staff', workspaceId: SHARED_WORKSPACE_ID })
  })

  it('refuses a staff create before the shared Workspace is registered', async () => {
    const ctx = new Context()
    roots.push(ctx)
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(RemoteAccessService)
    ctx.provide('workspaceRegistry', { create: () => new Promise(() => {}) } as never)
    await ctx.plugin(StaffAccess, { ownersFile: join(dir, 'owners.json'), djangoBaseUrl: 'https://django.test', workspaceDir: join(dir, 'workspace') })
    const call = createCall(STAFF)

    await expect(admit(ctx, call)).rejects.toMatchObject({ code: 'gateway/bad-request' })
    expect(call.request).toEqual({})
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

  it('keeps a named Session the caller owns', async () => {
    const ctx = await setup()
    ctx.staffSessions.owners.record(SessionId('mine'), 1)
    const call = createCall(STAFF, { sessionId: SessionId('mine') })

    await admit(ctx, call)

    expect(call.request).toEqual({ agentPreset: 'staff', workspaceId: SHARED_WORKSPACE_ID, sessionId: SessionId('mine') })
  })

  it('refuses a named Session another user owns', async () => {
    const ctx = await setup()
    ctx.staffSessions.owners.record(SessionId('theirs'), 2)
    const call = createCall(STAFF, { sessionId: SessionId('theirs') })

    await expect(admit(ctx, call)).rejects.toMatchObject({ code: 'gateway/bad-request' })
    expect(call.request).toEqual({ sessionId: SessionId('theirs') })
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

/** Fake database ownership service for the postgres admission path. */
function providePostgresServices(ctx: Context, ready = true): {
  view: PostgresOwnershipService
  commit: (id: SessionId, userId: number) => void
} {
  const owners = new Map<SessionId, number>()
  const reservations = new Map<SessionId, number>()
  const view: PostgresOwnershipService = {
    ownerOf: id => owners.get(id),
    sessionsOf: userId => [...owners].filter(([, owner]) => owner === userId).map(([id]) => id),
    ready: () => ready,
    reserve: (id, userId) => {
      const existing = reservations.get(id)
      if (existing !== undefined && existing !== userId) throw new Error('reserved by another user')
      reservations.set(id, userId)
      return async () => { reservations.delete(id) }
    },
    verify: async (id, userId) => owners.get(id) === userId,
    onUnavailable: () => () => undefined,
  }
  ctx.provide('sessionOwnership', view)
  ctx.provide('sessionPersistence', { name: 'session-persistence-postgres' } as never)
  return {
    view,
    commit(id, userId) {
      reservations.delete(id)
      owners.set(id, userId)
    },
  }
}

async function setupPostgres(ready = true) {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(RemoteAccessService)
  provideWorkspaceRegistry(ctx)
  const fake = providePostgresServices(ctx, ready)
  await ctx.plugin(StaffAccess, {
    ownership: 'postgres',
    djangoBaseUrl: 'https://django.test',
    workspaceDir: join(dir, 'workspace'),
  })
  await settle()
  return { ctx, ...fake }
}

describe('staff create admission with database ownership', () => {
  it('reserves the exact Session id for the caller and verifies the committed owner', async () => {
    const { ctx, commit } = await setupPostgres()
    const call = createCall(STAFF)
    await admit(ctx, call)
    if (call.reserve === undefined) throw new Error('postgres admission must install a reservation')
    const id = SessionId('minted-postgres')
    const release = await call.reserve(id)
    commit(id, 1)

    await ctx.parallel('api-session/created', id, STAFF)

    expect(ctx.staffSessions.owners.ownerOf(id)).toBe(1)
    await release()
  })

  it('keeps two concurrent users on their own reserved ids', async () => {
    const { ctx, commit } = await setupPostgres()
    const first = createCall(STAFF)
    const second = createCall(staffPrincipal({ userId: 2, role: 'ADMISSIONS_OFFICER' }))
    await Promise.all([admit(ctx, first), admit(ctx, second)])
    const firstId = SessionId('user-1')
    const secondId = SessionId('user-2')
    await Promise.all([first.reserve!(firstId), second.reserve!(secondId)])
    commit(firstId, 1)
    commit(secondId, 2)
    await Promise.all([
      ctx.parallel('api-session/created', firstId, STAFF),
      ctx.parallel('api-session/created', secondId, second.principal),
    ])
    expect(ctx.staffSessions.owners.ownerOf(firstId)).toBe(1)
    expect(ctx.staffSessions.owners.ownerOf(secondId)).toBe(2)
  })

  it('fails the created event when the committed owner is missing', async () => {
    const { ctx } = await setupPostgres()
    await expect(ctx.parallel('api-session/created', SessionId('unowned-db'), STAFF)).rejects.toThrow()
  })

  it('refuses a create while the database ownership view is unavailable', async () => {
    const { ctx } = await setupPostgres(false)
    await expect(admit(ctx, createCall(STAFF))).rejects.toMatchObject({ code: 'gateway/internal' })
  })
})
