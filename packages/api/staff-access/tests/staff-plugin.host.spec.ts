import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import { SessionId } from '@deepseek-ai/dsh-session'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as StaffAccess from '../src/plugin.ts'
import { staffPrincipal } from '../src/index.ts'

const STAFF = staffPrincipal({ userId: 1, role: 'ADMISSIONS_OFFICER' })
const GLOBAL = { kind: 'global' } as const

let dir: string
const roots: Context[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'staff-plugin-'))
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
  return ctx
}

describe('staff access plugin configuration', () => {
  it('refuses to mount without an owners file', async () => {
    const ctx = await setup()
    const missing = {} as StaffAccess.Config
    expect(() => { StaffAccess.apply(ctx, missing) }).toThrow('staff-access: ownersFile is required')
    expect(() => { StaffAccess.apply(ctx, { ownersFile: '', djangoBaseUrl: 'https://django.test' }) }).toThrow('staff-access: ownersFile is required')
  })
})

describe('staff access plugin mount', () => {
  it('provides the owner index and registers the staff policy', async () => {
    const ctx = await setup()
    await ctx.plugin(StaffAccess, { ownersFile: join(dir, 'owners.json'), djangoBaseUrl: 'https://django.test' })
    ctx.staffSessions.owners.record(SessionId('s1'), 1)
    expect(ctx.staffSessions.owners.ownerOf(SessionId('s1'))).toBe(1)
    expect(ctx.remoteAccess.decide({ principal: STAFF, action: 'session/list', resources: [GLOBAL] })).toEqual({ kind: 'allow' })
  })

  it('removes the staff policy when the plugin fiber is disposed', async () => {
    const ctx = await setup()
    const fiber = ctx.plugin(StaffAccess, { ownersFile: join(dir, 'owners.json'), djangoBaseUrl: 'https://django.test' })
    await fiber
    expect(ctx.remoteAccess.decide({ principal: STAFF, action: 'session/list', resources: [GLOBAL] })).toEqual({ kind: 'allow' })
    await fiber.dispose()
    expect(ctx.remoteAccess.decide({ principal: STAFF, action: 'session/list', resources: [GLOBAL] })).toEqual({ kind: 'deny', reason: 'no-allow' })
  })
})

describe('staffPrincipal', () => {
  it('copies only the kind, user id, and role of its identity', () => {
    const identity = { userId: 1, role: 'X', email: 'a@b.c' }
    const principal = staffPrincipal(identity)
    expect(principal).toEqual({ kind: 'staff', userId: 1, role: 'X' })
    expect(principal).not.toHaveProperty('email')
  })
})
