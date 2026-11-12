import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import RemoteAccessService, {
  type RemoteAccessAction,
  type RemoteAccessResource,
} from '@deepseek-ai/dsh-api-remote-access'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { SessionId } from '@deepseek-ai/dsh-session'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createSessionOwnerIndex,
  createStaffPolicy,
  staffPrincipal,
  type SessionOwnerIndex,
} from '../src/index.ts'

const ALICE = staffPrincipal({ userId: 1, role: 'ADMISSIONS_OFFICER' })
const BOB = staffPrincipal({ userId: 2, role: 'ADMISSIONS_OFFICER' })
const S1 = SessionId('s1')
const S2 = SessionId('s2')
const S3 = SessionId('s3')
const GLOBAL: RemoteAccessResource = { kind: 'global' }
const session = (id: SessionId): RemoteAccessResource => ({ kind: 'session', id })

const OWNED_ACTIONS: readonly RemoteAccessAction[] = [
  'commands/list', 'goals/get', 'skills/list', 'session/list', 'workspace/follow', 'session/create', 'session/prompt', 'session/cancel',
  'session/follow', 'session/page', 'session/projections', 'session/observeProjections',
  'session/observeEvent', 'session/observeState', 'session/state', 'session/events', 'session/wait',
  'session/attachment', 'session/rename', 'session/updateQueue', 'toolResults/watch',
  'event:api-session/activity', 'event:api-session/added', 'event:api-session/error',
  'event:api-session/removed', 'event:api-session/status',
]

const GLOBAL_ACTIONS: readonly RemoteAccessAction[] = [
  'session/list', 'session/create', 'commands/list', 'workspace/follow', 'session/control',
  'agentPresets/list', 'permissionPresets/catalog', 'session/modelCatalog',
]

const DENIED_ACTIONS: readonly RemoteAccessAction[] = [
  'fileUploads/upload', 'llm/listProviders', 'llm/listConfigurableProviders',
  'session/selectModel', 'session/search', 'session/fork', 'session/openWorkspacePath',
  'session/canOpenWorkspacePath', 'account/get', 'credentials/list', 'settings/get', 'terminal/open',
  'workspaceFiles/list', 'directoryPicker/open', 'pluginManager/list', 'schedule/list', 'jobs/list',
  'settings/describe', 'credentials/describe', 'dynamicCordisRunner/inventory', 'dynamicCordisRunner/syncInspectManifest',
  'nonsense/method',
]

let dir: string
const roots: Context[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'staff-policy-'))
})

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
  rmSync(dir, { recursive: true, force: true })
})

/** Test-only session namespace whose list method filters its items through the access policy. */
class Sessions extends TypertRemoteService {
  static inject = ['remoteAccess']

  constructor(ctx: Context) { super(ctx, 'session') }

  @Remote
  list(): string[] {
    return ['s1', 's2', 's3'].filter(id => this.ctx.remoteAccess.allows(session(SessionId(id))))
  }
}

async function setup(options: { readonly registerPolicy?: boolean } = {}): Promise<{
  readonly ctx: Context
  readonly owners: SessionOwnerIndex
}> {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(RemoteAccessService)
  await ctx.plugin(TypertGatewayService)
  const owners = createSessionOwnerIndex({ file: join(dir, 'owners.json') })
  owners.record(S1, 1)
  owners.record(S2, 2)
  if (options.registerPolicy !== false) ctx.remoteAccess.registerPolicy('staff', createStaffPolicy({ ownership: owners, workspaceId: () => undefined }))
  return { ctx, owners }
}

describe('staff policy allows', () => {
  it('lets a user take every per-session action on a session the user owns', async () => {
    const { ctx } = await setup()
    for (const action of OWNED_ACTIONS) {
      expect(ctx.remoteAccess.decide({ principal: ALICE, action, resources: [session(S1)] }), action).toEqual({ kind: 'allow' })
    }
  })

  it('binds exactly the owned actions to an owned session', async () => {
    const { ctx } = await setup()
    const snapshot = ctx.remoteAccess.snapshotFor(ALICE)
    if (snapshot.owner) throw new Error('staff snapshot must not be the owner baseline')
    const grant = snapshot.grants.find(item => item.resource.kind === 'session' && item.resource.id === S1)
    // Snapshot grants list endpoint actions only; the role's `event:` actions are checked by the loop above.
    expect(grant?.actions).toEqual(OWNED_ACTIONS.filter(action => !action.startsWith('event:')).sort())
  })

  it('lets a create name a Session the user owns', async () => {
    const { ctx } = await setup()
    expect(ctx.remoteAccess.decide({ principal: ALICE, action: 'session/create', resources: [session(S1)] })).toEqual({ kind: 'allow' })
  })

  it('refuses a create that names a Session another user owns or nobody owns', async () => {
    const { ctx } = await setup()
    expect(ctx.remoteAccess.decide({ principal: ALICE, action: 'session/create', resources: [session(S2)] }))
      .toEqual({ kind: 'deny', reason: 'no-allow' })
    expect(ctx.remoteAccess.decide({ principal: ALICE, action: 'session/create', resources: [session(SessionId('unknown'))] }))
      .toEqual({ kind: 'deny', reason: 'no-allow' })
  })

  it('lets a user take every global action', async () => {
    const { ctx } = await setup()
    for (const action of GLOBAL_ACTIONS) {
      expect(ctx.remoteAccess.decide({ principal: ALICE, action, resources: [GLOBAL] }), action).toEqual({ kind: 'allow' })
    }
  })
})

describe('staff policy refusals', () => {
  it('refuses every per-session action on a session another user owns or nobody owns', async () => {
    const { ctx } = await setup()
    for (const action of OWNED_ACTIONS) {
      for (const sessionId of [S2, S3]) {
        expect(ctx.remoteAccess.decide({ principal: ALICE, action, resources: [session(sessionId)] }), `${action} ${sessionId}`)
          .toEqual({ kind: 'deny', reason: 'no-allow' })
      }
    }
  })

  it('refuses every denied action on the global resource and on an owned session', async () => {
    const { ctx } = await setup()
    for (const action of DENIED_ACTIONS) {
      expect(ctx.remoteAccess.decide({ principal: ALICE, action, resources: [GLOBAL] }), `${action} global`).toMatchObject({ kind: 'deny' })
      expect(ctx.remoteAccess.decide({ principal: ALICE, action, resources: [session(S1)] }), `${action} s1`).toMatchObject({ kind: 'deny' })
    }
  })

  it('refuses a request that mixes an owned and a foreign session', async () => {
    const { ctx } = await setup()
    expect(ctx.remoteAccess.decide({ principal: ALICE, action: 'session/prompt', resources: [session(S1), session(S2)] }))
      .toEqual({ kind: 'deny', reason: 'no-allow' })
  })

  it('refuses a session the index names to another user even when a binding was listed', async () => {
    const { ctx, owners } = await setup({ registerPolicy: false })
    const shifted: SessionOwnerIndex = { ...owners, ownerOf: () => 2 }
    ctx.remoteAccess.registerPolicy('staff', createStaffPolicy({ ownership: shifted, workspaceId: () => undefined }))
    expect(ctx.remoteAccess.decide({ principal: ALICE, action: 'session/prompt', resources: [session(S1)] }))
      .toEqual({ kind: 'deny', reason: 'session-not-owned' })
  })

  it('refuses every call when no staff policy is mounted', async () => {
    const { ctx } = await setup({ registerPolicy: false })
    expect(ctx.remoteAccess.decide({ principal: ALICE, action: 'session/list', resources: [GLOBAL] }))
      .toEqual({ kind: 'deny', reason: 'no-allow' })
  })
})

describe('staff ownership changes', () => {
  it('takes effect on the next decision when an owner is forgotten or recorded for another user', async () => {
    const { ctx, owners } = await setup()
    expect(ctx.remoteAccess.decide({ principal: ALICE, action: 'session/prompt', resources: [session(S1)] })).toEqual({ kind: 'allow' })
    owners.forget(S1)
    expect(ctx.remoteAccess.decide({ principal: ALICE, action: 'session/prompt', resources: [session(S1)] })).toEqual({ kind: 'deny', reason: 'no-allow' })
    owners.record(S1, 2)
    expect(ctx.remoteAccess.decide({ principal: BOB, action: 'session/prompt', resources: [session(S1)] })).toEqual({ kind: 'allow' })
    expect(ctx.remoteAccess.decide({ principal: ALICE, action: 'session/prompt', resources: [session(S1)] })).toEqual({ kind: 'deny', reason: 'no-allow' })
  })
})

describe('staff session list', () => {
  it('shows each user only the sessions the user owns', async () => {
    const { ctx } = await setup()
    await ctx.plugin(Sessions)
    const list = (principal: typeof ALICE): Promise<unknown> =>
      ctx.typertGateway.invoke({ peer: new Peer(ctx, { principal }), namespace: 'session', method: 'list', args: {} })
    await expect(list(ALICE)).resolves.toEqual(['s1'])
    await expect(list(BOB)).resolves.toEqual(['s2'])
  })
})

describe('staff access snapshot', () => {
  it('opens a staff reader with a non-owner baseline that lists only the user\'s own session', async () => {
    const { ctx } = await setup()
    const snapshot = ctx.remoteAccess.snapshotFor(ALICE)
    expect(snapshot).toMatchObject({ type: 'baseline', owner: false })
    const serialized = JSON.stringify(snapshot)
    expect(serialized).toContain('"id":"s1"')
    expect(serialized).not.toContain('"id":"s2"')
  })
})
