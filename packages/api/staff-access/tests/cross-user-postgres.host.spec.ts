import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import RemoteAccessService, { type RemoteAccessAction } from '@deepseek-ai/dsh-api-remote-access'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as PostgresPersistence from '@deepseek-ai/dsh-session-persistence-postgres'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { Client, Pool } from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as StaffAccess from '../src/plugin.ts'
import { staffPrincipal } from '../src/index.ts'
import { provideWorkspaceRegistry, settle } from './workspace-registry-stub.ts'
import { meta, oneTurnLog } from '../../../session/session-persistence/tests/contract.ts'

const connectionString = process.env.DSH_TEST_POSTGRES_URL
const describeDb = connectionString === undefined ? describe.skip : describe

/** Serializes database tests across files that share one test database. */
const DB_TEST_LOCK = 1_684_301_172
let dbLock: Client | undefined

const ALICE = staffPrincipal({ userId: 1, role: 'ADMISSIONS_OFFICER' })
const BOB = staffPrincipal({ userId: 2, role: 'ADMISSIONS_OFFICER' })

/** Every per-Session method a staff role can reach; each must refuse a foreign Session. */
const PRIVATE_ACTIONS: readonly RemoteAccessAction[] = [
  'commands/list', 'goals/get', 'skills/list', 'session/list', 'workspace/follow', 'session/create',
  'session/prompt', 'session/cancel', 'session/follow', 'session/page', 'session/projections',
  'session/observeProjections', 'session/observeEvent', 'session/observeState', 'session/state',
  'session/events', 'session/wait', 'session/attachment', 'session/rename', 'session/updateQueue',
  'toolResults/watch',
  'event:api-session/activity', 'event:api-session/added', 'event:api-session/error',
  'event:api-session/removed', 'event:api-session/status',
]

const session = (id: string) => ({ kind: 'session' as const, id: SessionId(id) })

let dir: string
let aliceId: string
let bobId: string
const roots: Context[] = []
const createdIds: string[] = []

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'staff-cross-user-'))
  aliceId = `alice-${randomUUID()}`
  bobId = `bob-${randomUUID()}`
  if (connectionString === undefined) return
  dbLock = new Client({ connectionString })
  await dbLock.connect()
  await dbLock.query('SELECT pg_advisory_lock($1)', [DB_TEST_LOCK])
})

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
  if (connectionString !== undefined && createdIds.length > 0) {
    const pool = new Pool({ connectionString })
    try {
      await pool.query('DELETE FROM dsh_sessions WHERE id = ANY($1::text[])', [createdIds.splice(0)])
    } finally {
      await pool.end()
    }
  }
  rmSync(dir, { recursive: true, force: true })
  const lock = dbLock
  dbLock = undefined
  if (lock !== undefined) {
    try {
      await lock.query('SELECT pg_advisory_unlock($1)', [DB_TEST_LOCK])
    } finally {
      await lock.end()
    }
  }
})

/** Mount the real Postgres provider and the staff composition over it. */
async function mount(): Promise<Context> {
  if (connectionString === undefined) throw new Error('DSH_TEST_POSTGRES_URL is required')
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(RemoteAccessService)
  await ctx.plugin(TypertGatewayService)
  provideWorkspaceRegistry(ctx)
  await ctx.plugin(PostgresPersistence, { connectionString })
  await ctx.plugin(StaffAccess, {
    ownership: 'postgres',
    djangoBaseUrl: 'https://django.test',
    workspaceDir: join(dir, 'workspace'),
  })
  await settle()
  return ctx
}

/** Create one durable, staff-owned chat through the provider's reservation path. */
async function createOwned(ctx: Context, id: string, userId: number): Promise<void> {
  createdIds.push(id)
  ctx.sessionOwnership.reserve(SessionId(id), userId)
  const handle = await ctx.sessionPersistence.create(meta(id, '/work'))
  await handle.append(oneTurnLog())
  await handle.close()
}

function decide(ctx: Context, principal: typeof ALICE, action: RemoteAccessAction, id: string) {
  return ctx.remoteAccess.decide({ principal, action, resources: [session(id)] })
}

describeDb('cross-user chat isolation on Postgres', () => {
  it('refuses every read and mutation of another user\'s chat, before and after restart', async () => {
    let ctx = await mount()
    await createOwned(ctx, aliceId, 1)
    await createOwned(ctx, bobId, 2)

    for (const action of PRIVATE_ACTIONS) {
      expect(decide(ctx, ALICE, action, bobId), `alice ${action}`).toEqual({ kind: 'deny', reason: 'no-allow' })
      expect(decide(ctx, BOB, action, aliceId), `bob ${action}`).toEqual({ kind: 'deny', reason: 'no-allow' })
      expect(decide(ctx, ALICE, action, aliceId), `alice own ${action}`).toEqual({ kind: 'allow' })
      expect(decide(ctx, BOB, action, bobId), `bob own ${action}`).toEqual({ kind: 'allow' })
    }
    expect(ctx.sessionOwnership.sessionsOf(1)).toContain(SessionId(aliceId))
    expect(ctx.sessionOwnership.sessionsOf(1)).not.toContain(SessionId(bobId))
    expect(ctx.sessionOwnership.sessionsOf(2)).toContain(SessionId(bobId))
    expect(ctx.sessionOwnership.sessionsOf(2)).not.toContain(SessionId(aliceId))

    await ctx.fiber.dispose()
    ctx = await mount()

    for (const action of PRIVATE_ACTIONS) {
      expect(decide(ctx, ALICE, action, bobId), `after restart alice ${action}`).toEqual({ kind: 'deny', reason: 'no-allow' })
      expect(decide(ctx, BOB, action, aliceId), `after restart bob ${action}`).toEqual({ kind: 'deny', reason: 'no-allow' })
      expect(decide(ctx, ALICE, action, aliceId), `after restart alice own ${action}`).toEqual({ kind: 'allow' })
    }
  })

  it('refuses a request that mixes an owned and a foreign Session', async () => {
    const ctx = await mount()
    await createOwned(ctx, aliceId, 1)
    await createOwned(ctx, bobId, 2)
    expect(ctx.remoteAccess.decide({
      principal: ALICE,
      action: 'session/prompt',
      resources: [session(aliceId), session(bobId)],
    })).toEqual({ kind: 'deny', reason: 'no-allow' })
  })

  it('lists only the caller\'s own chats and serializes no foreign id', async () => {
    const ctx = await mount()
    await createOwned(ctx, aliceId, 1)
    await createOwned(ctx, bobId, 2)
    await ctx.plugin(Sessions)
    Sessions.ids = [aliceId, bobId]
    const list = (principal: typeof ALICE): Promise<unknown> =>
      ctx.typertGateway.invoke({ peer: new Peer(ctx, { principal }), namespace: 'session', method: 'list', args: {} })
    await expect(list(ALICE)).resolves.toEqual([aliceId])
    await expect(list(BOB)).resolves.toEqual([bobId])
    const snapshot = JSON.stringify(ctx.remoteAccess.snapshotFor(ALICE))
    expect(snapshot).toContain(aliceId)
    expect(snapshot).not.toContain(bobId)
  })

})

/** Test-only Session namespace whose list method filters items through the policy. */
class Sessions extends TypertRemoteService {
  static inject = ['remoteAccess']
  static ids: string[] = []

  constructor(ctx: Context) { super(ctx, 'session') }

  @Remote
  list(): string[] {
    return Sessions.ids.filter(id => this.ctx.remoteAccess.allows({ kind: 'session', id: SessionId(id) }))
  }
}
