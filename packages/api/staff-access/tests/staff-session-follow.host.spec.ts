import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import type { RemoteAccessResource } from '@deepseek-ai/dsh-typert-protocol'
import { SessionId } from '@deepseek-ai/dsh-session'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as StaffAccess from '../src/plugin.ts'
import { staffPrincipal } from '../src/index.ts'
import { provideWorkspaceRegistry, settle } from './workspace-registry-stub.ts'

const ALICE = staffPrincipal({ userId: 1, role: 'ADMISSIONS_OFFICER' })
const BOB = staffPrincipal({ userId: 2, role: 'ADMISSIONS_OFFICER' })
const GLOBAL: RemoteAccessResource = { kind: 'global' }
const OWN = SessionId('alice-own')
const OTHER = SessionId('bob-own')
const NEW = SessionId('alice-new')
const session = (id: SessionId): RemoteAccessResource => ({ kind: 'session', id })

let dir: string
const roots: Context[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'staff-follow-'))
})

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
  rmSync(dir, { recursive: true, force: true })
})

async function setup(): Promise<Context> {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(RemoteAccessService)
  provideWorkspaceRegistry(ctx)
  await ctx.plugin(StaffAccess, { ownersFile: join(dir, 'owners.json'), djangoBaseUrl: 'https://django.test', workspaceDir: join(dir, 'workspace') })
  await settle()
  ctx.staffSessions.owners.record(OWN, 1)
  ctx.staffSessions.owners.record(OTHER, 2)
  return ctx
}

describe('staff session follow', () => {
  it('lets a user follow and list commands for its own session', async () => {
    const ctx = await setup()
    expect(ctx.remoteAccess.decide({ principal: ALICE, action: 'session/follow', resources: [session(OWN)] })).toEqual({ kind: 'allow' })
    expect(ctx.remoteAccess.decide({ principal: ALICE, action: 'commands/list', resources: [session(OWN)] })).toEqual({ kind: 'allow' })
  })

  it('makes a brand-new session followable as soon as create returns', async () => {
    const ctx = await setup()
    await ctx.parallel('api-session/created', NEW, ALICE)
    expect(ctx.remoteAccess.decide({ principal: ALICE, action: 'session/follow', resources: [session(NEW)] })).toEqual({ kind: 'allow' })
    expect(ctx.remoteAccess.decide({ principal: ALICE, action: 'commands/list', resources: [session(NEW)] })).toEqual({ kind: 'allow' })
  })

  it('refuses another user session in both directions', async () => {
    const ctx = await setup()
    expect(ctx.remoteAccess.decide({ principal: ALICE, action: 'session/follow', resources: [session(OTHER)] }))
      .toEqual({ kind: 'deny', reason: 'no-allow' })
    expect(ctx.remoteAccess.decide({ principal: BOB, action: 'session/follow', resources: [session(OWN)] }))
      .toEqual({ kind: 'deny', reason: 'no-allow' })
    expect(ctx.remoteAccess.decide({ principal: ALICE, action: 'commands/list', resources: [session(OTHER)] }))
      .toEqual({ kind: 'deny', reason: 'no-allow' })
  })

  it('does not admit session/follow as a global call', async () => {
    const ctx = await setup()
    expect(ctx.remoteAccess.decide({ principal: ALICE, action: 'session/follow', resources: [GLOBAL] }))
      .toEqual({ kind: 'deny', reason: 'no-allow' })
  })

  it('lists only the caller sessions in its access snapshot', async () => {
    const ctx = await setup()
    await ctx.parallel('api-session/created', NEW, ALICE)
    const snapshot = ctx.remoteAccess.snapshotFor(ALICE)
    if (snapshot.owner) throw new Error('staff snapshot must not be the owner baseline')
    const sessions = snapshot.grants.map(grant => grant.resource).filter(resource => resource.kind === 'session')
    expect(sessions).toEqual(expect.arrayContaining([session(OWN), session(NEW)]))
    expect(sessions).not.toContainEqual(session(OTHER))
  })

  it('leaves the owner unaffected', async () => {
    const ctx = await setup()
    expect(ctx.remoteAccess.decide({ principal: { kind: 'owner' }, action: 'session/follow', resources: [session(OTHER)] })).toEqual({ kind: 'allow' })
  })
})
