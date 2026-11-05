import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RemoteAccessAction } from '@deepseek-ai/dsh-api-remote-access/types'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Principal, RemoteAccessResource } from '@deepseek-ai/dsh-typert-protocol'
import * as StaffAccess from '../src/plugin.ts'
import { staffPrincipal } from '../src/index.ts'
import { provideWorkspaceRegistry, SHARED_WORKSPACE_ID, settle } from './workspace-registry-stub.ts'

const STAFF = staffPrincipal({ userId: 1, role: 'ADMISSIONS_OFFICER' })
const GLOBAL = { kind: 'global' } as const
const SHARED = { kind: 'workspace', id: SHARED_WORKSPACE_ID } as const
const OTHER = { kind: 'workspace', id: 'owner-ws' as typeof SHARED_WORKSPACE_ID } as const
const MARKER = '.dsh-staff-workspace'
/** Calls the staff chat screen needs must stay refused: settings, credentials, Cordis runner, catalogs, and workspace init. */
const READ_ONLY: readonly RemoteAccessAction[] = [
  'agentPresets/list',
  'permissionPresets/catalog',
  'session/modelCatalog',
]
const DENIED: readonly RemoteAccessAction[] = [
  'settings/describe',
  'credentials/describe',
  'dynamicCordisRunner/inventory',
  'dynamicCordisRunner/syncInspectManifest',
  'workspace/initializeDefault',
]

let dir: string
const roots: Context[] = []
const savedHome = process.env.DSH_HOME

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'staff-workspace-'))
})

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
  if (savedHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedHome
  rmSync(dir, { recursive: true, force: true })
})

async function mount(workspaceDir: string | undefined, created: string[] = []): Promise<Context> {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(RemoteAccessService)
  provideWorkspaceRegistry(ctx, created)
  await ctx.plugin(StaffAccess, {
    ownersFile: join(dir, 'owners.json'),
    djangoBaseUrl: 'https://django.test',
    ...workspaceDir === undefined ? {} : { workspaceDir },
  })
  await settle()
  return ctx
}

describe('staff Workspace policy', () => {
  it('lets a staff user follow and create in the shared Workspace only', async () => {
    const ctx = await mount(join(dir, 'workspace'))
    expect(ctx.remoteAccess.decide({ principal: STAFF, action: 'workspace/follow', resources: [SHARED] })).toEqual({ kind: 'allow' })
    expect(ctx.remoteAccess.decide({ principal: STAFF, action: 'session/create', resources: [SHARED] })).toEqual({ kind: 'allow' })
  })

  it('refuses every other Workspace for follow and create', async () => {
    const ctx = await mount(join(dir, 'workspace'))
    expect(ctx.remoteAccess.decide({ principal: STAFF, action: 'workspace/follow', resources: [OTHER] }))
      .toEqual({ kind: 'deny', reason: 'no-allow' })
    expect(ctx.remoteAccess.decide({ principal: STAFF, action: 'session/create', resources: [OTHER] }))
      .toEqual({ kind: 'deny', reason: 'no-allow' })
  })

  it('binds no Workspace before the shared one is registered', async () => {
    const ctx = new Context()
    roots.push(ctx)
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(RemoteAccessService)
    ctx.provide('workspaceRegistry', { create: () => new Promise(() => {}) } as never)
    await ctx.plugin(StaffAccess, { ownersFile: join(dir, 'owners.json'), djangoBaseUrl: 'https://django.test', workspaceDir: join(dir, 'workspace') })
    expect(ctx.remoteAccess.decide({ principal: STAFF, action: 'workspace/follow', resources: [SHARED] }))
      .toEqual({ kind: 'deny', reason: 'no-allow' })
  })

  it.each(DENIED)('keeps %s denied for staff', async (action) => {
    const ctx = await mount(join(dir, 'workspace'))
    expect(ctx.remoteAccess.decide({ principal: STAFF, action, resources: [GLOBAL] })).toEqual({ kind: 'deny', reason: 'no-allow' })
  })

  it.each(READ_ONLY)('lets staff call the read-only %s', async (action) => {
    const ctx = await mount(join(dir, 'workspace'))
    expect(ctx.remoteAccess.decide({ principal: STAFF, action, resources: [GLOBAL] })).toEqual({ kind: 'allow' })
  })

  it('leaves the owner unaffected', async () => {
    const ctx = await mount(join(dir, 'workspace'))
    const actions: readonly RemoteAccessAction[] = [...DENIED, ...READ_ONLY, 'workspace/follow']
    for (const action of actions) {
      expect(ctx.remoteAccess.decide({ principal: { kind: 'owner' }, action, resources: [OTHER] })).toEqual({ kind: 'allow' })
    }
  })
})

describe('staff create naming a Session', () => {
  const OWN = SessionId('own-blank')
  const FOREIGN = SessionId('foreign-blank')
  const session = (id: SessionId): RemoteAccessResource => ({ kind: 'session', id })

  it('is allowed for an own Session in the shared Workspace and refused for any other', async () => {
    const ctx = await mount(join(dir, 'workspace'))
    ctx.staffSessions.owners.record(OWN, 1)
    ctx.staffSessions.owners.record(FOREIGN, 2)
    const create = (id: SessionId): unknown => ctx.remoteAccess.decide({ principal: STAFF, action: 'session/create', resources: [SHARED, session(id)] })
    expect(create(OWN)).toEqual({ kind: 'allow' })
    expect(create(FOREIGN)).toEqual({ kind: 'deny', reason: 'no-allow' })
    expect(create(SessionId('unknown'))).toEqual({ kind: 'deny', reason: 'no-allow' })
  })

  it('leaves the owner unaffected', async () => {
    const ctx = await mount(join(dir, 'workspace'))
    expect(ctx.remoteAccess.decide({ principal: { kind: 'owner' }, action: 'session/create', resources: [SHARED, session(FOREIGN)] }))
      .toEqual({ kind: 'allow' })
  })
})

describe('staff Workspace follow view', () => {
  const ALICE_OWN = [SessionId('alice-1'), SessionId('alice-2')]
  const BOB_OWN = [SessionId('bob-1')]
  const NEW_SESSION = SessionId('alice-new')
  const BOB = staffPrincipal({ userId: 2, role: 'ADMISSIONS_OFFICER' })
  const session = (id: SessionId): RemoteAccessResource => ({ kind: 'session', id })

  async function mountWithSessions(): Promise<Context> {
    const ctx = await mount(join(dir, 'workspace'))
    for (const id of ALICE_OWN) ctx.staffSessions.owners.record(id, 1)
    for (const id of BOB_OWN) ctx.staffSessions.owners.record(id, 2)
    return ctx
  }

  /** The ids `WorkspaceController.follow` keeps: each is tested with `allows()` against the action `workspace/follow`. */
  function followView(ctx: Context, principal: Principal, ids: readonly SessionId[]): SessionId[] {
    return ids.filter(id => ctx.remoteAccess.decide({ principal, action: 'workspace/follow', resources: [session(id)] }).kind === 'allow')
  }

  it('shows each staff user exactly the shared Workspace sessions that user owns', async () => {
    const ctx = await mountWithSessions()
    const all = [...ALICE_OWN, ...BOB_OWN]
    expect(followView(ctx, STAFF, all)).toEqual(ALICE_OWN)
    expect(followView(ctx, BOB, all)).toEqual(BOB_OWN)
  })

  it('keeps another user sessions out of the archived and pinned sets', async () => {
    const ctx = await mountWithSessions()
    const archived = [ALICE_OWN[1], ...BOB_OWN].filter(id => id !== undefined)
    expect(followView(ctx, STAFF, archived)).toEqual([ALICE_OWN[1]])
    expect(followView(ctx, BOB, [...ALICE_OWN, ...BOB_OWN])).not.toContain(ALICE_OWN[0])
  })

  it('shows a brand-new own session as soon as create returns', async () => {
    const ctx = await mountWithSessions()
    expect(followView(ctx, STAFF, [NEW_SESSION])).toEqual([])
    await ctx.parallel('api-session/created', NEW_SESSION, STAFF)
    expect(followView(ctx, STAFF, [NEW_SESSION])).toEqual([NEW_SESSION])
    expect(followView(ctx, BOB, [NEW_SESSION])).toEqual([])
  })

  it('shows the owner every session', async () => {
    const ctx = await mountWithSessions()
    expect(followView(ctx, { kind: 'owner' }, [...ALICE_OWN, ...BOB_OWN])).toEqual([...ALICE_OWN, ...BOB_OWN])
  })
})

describe('staff Workspace directory', () => {
  it('creates the empty directory and registers it at mount', async () => {
    const created: string[] = []
    const target = join(dir, 'workspace')
    await mount(target, created)
    expect(existsSync(target)).toBe(true)
    expect(readdirSync(target)).toEqual([MARKER])
    expect(created).toEqual([target])
  })

  it('reuses the same directory after a restart', async () => {
    const target = join(dir, 'workspace')
    const first: string[] = []
    const ctx = await mount(target, first)
    await ctx.fiber.dispose()
    const second: string[] = []
    await mount(target, second)
    expect(readdirSync(target)).toEqual([MARKER])
    expect(second).toEqual([target])
  })

  it('refuses an existing directory that holds content staff access did not create', async () => {
    const target = join(dir, 'workspace')
    mkdirSync(target)
    writeFileSync(join(target, 'notes.txt'), 'x')
    const ctx = new Context()
    roots.push(ctx)
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(RemoteAccessService)
    provideWorkspaceRegistry(ctx)
    expect(() => { StaffAccess.apply(ctx, { ownersFile: join(dir, 'owners.json'), djangoBaseUrl: 'https://django.test', workspaceDir: target }) })
      .toThrow('staff-access: workspaceDir is not empty and was not prepared by staff access')
  })

  it('refuses a relative workspaceDir', async () => {
    const ctx = new Context()
    roots.push(ctx)
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(RemoteAccessService)
    provideWorkspaceRegistry(ctx)
    expect(() => { StaffAccess.apply(ctx, { ownersFile: join(dir, 'owners.json'), djangoBaseUrl: 'https://django.test', workspaceDir: 'relative/dir' }) })
      .toThrow('staff-access: workspaceDir must be an absolute path')
  })

  it('defaults to staff-workspace under the Harness home', async () => {
    process.env.DSH_HOME = join(dir, 'home')
    const created: string[] = []
    await mount(undefined, created)
    expect(created).toEqual([join(dir, 'home', 'staff-workspace')])
    expect(existsSync(join(dir, 'home', 'staff-workspace', MARKER))).toBe(true)
  })
})
