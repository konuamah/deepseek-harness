import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  SessionFormatUnsupportedError,
  SessionOwnershipLostError,
  SessionPersistenceCorruptionError,
} from '@deepseek-ai/dsh-session-persistence'
import { Client, Pool } from 'pg'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as PostgresPersistence from '@deepseek-ai/dsh-session-persistence-postgres'
import SessionStore from '@deepseek-ai/dsh-session'
import { meta, oneTurnLog, runPersistenceContract } from '../../session-persistence/tests/contract.ts'

const connectionString = process.env.DSH_TEST_POSTGRES_URL
const describeDb = connectionString === undefined ? describe.skip : describe
/** Serializes database tests across files that share one test database. */
const DB_TEST_LOCK = 1_684_301_172

let dbLock: Client | undefined
beforeEach(async () => {
  if (connectionString === undefined) return
  dbLock = new Client({ connectionString })
  await dbLock.connect()
  await dbLock.query('SELECT pg_advisory_lock($1)', [DB_TEST_LOCK])
})
afterEach(async () => {
  const lock = dbLock
  dbLock = undefined
  if (lock === undefined) return
  try {
    await lock.query('SELECT pg_advisory_unlock($1)', [DB_TEST_LOCK])
  } finally {
    await lock.end()
  }
})

function databaseUrl(): string {
  if (connectionString === undefined) throw new Error('DSH_TEST_POSTGRES_URL is required')
  return connectionString
}

async function truncate(): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl() })
  try {
    await pool.query('TRUNCATE dsh_session_events, dsh_sessions')
  } catch (error: unknown) {
    // The first run has no tables yet; the provider migration creates them.
    if ((error as { code?: unknown }).code !== '42P01') throw error
  } finally {
    await pool.end()
  }
}

async function mount(overrides: Partial<PostgresPersistence.Config> = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(PostgresPersistence, { connectionString: databaseUrl(), ...overrides })
  return ctx
}

async function reopen(): Promise<{ ctx: Context; persistence: Context['sessionPersistence']; dispose: () => Promise<void> }> {
  const ctx = await mount()
  return { ctx, persistence: ctx.sessionPersistence, dispose: async () => { await ctx.fiber.dispose() } }
}

describeDb('SessionPersistence contract: postgres', () => {
  runPersistenceContract('postgres', async () => {
    await truncate()
    const ctx = await mount()
    return {
      persistence: ctx.sessionPersistence,
      dispose: async () => { await ctx.fiber.dispose() },
      reopen,
    }
  })
})

describeDb('postgres storage internals', () => {
  it('commits an escaped NUL in event text and reads the exact value back', async () => {
    const ctx = await mount()
    try {
      const handle = await ctx.sessionPersistence.create(meta('nul-text', '/work'))
      const log = oneTurnLog()
      const user = log[1] as SessionEvent<'user/message'>
      log[1] = {
        ...user,
        data: { ...user.data, content: [{ type: 'text' as const, text: 'a\u0000b' }] },
      }
      await handle.append(log)
      const read = await handle.read()
      expect((read.events[1] as SessionEvent<'user/message'>).data.content).toEqual([{ type: 'text', text: 'a\u0000b' }])
      await handle.close()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('refuses malformed stored event text and a future header version', async () => {
    const ctx = await mount()
    try {
      const handle = await ctx.sessionPersistence.create(meta('corrupt', '/work'))
      await handle.append(oneTurnLog())
      await handle.close()
      const pool = new Pool({ connectionString: databaseUrl() })
      try {
        await pool.query('UPDATE dsh_session_events SET payload = $1 WHERE session_id = $2 AND seq = 1', ['not json', 'corrupt'])
        const reader = await ctx.sessionPersistence.open(SessionId('corrupt'), 'read')
        await expect(reader.read()).rejects.toBeInstanceOf(SessionPersistenceCorruptionError)
        await reader.close()
      } finally {
        await pool.end()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('refuses a stored header written by a newer format version', async () => {
    const ctx = await mount()
    try {
      const handle = await ctx.sessionPersistence.create(meta('future-header', '/work'))
      await handle.flush()
      await handle.close()
      const pool = new Pool({ connectionString: databaseUrl() })
      try {
        const header = JSON.stringify({ ...meta('future-header', '/work'), version: 99 })
        await pool.query('UPDATE dsh_sessions SET header = $1 WHERE id = $2', [header, 'future-header'])
      } finally {
        await pool.end()
      }
      await expect(ctx.sessionPersistence.open(SessionId('future-header'), 'read')).rejects.toBeInstanceOf(SessionFormatUnsupportedError)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('takes over an expired writer lease and fences the stale handle', async () => {
    const first = await mount()
    const second = await mount({ leaseMs: 2_000, renewIntervalMs: 1_000 })
    try {
      const stale = await first.sessionPersistence.create(meta('fenced', '/work'))
      await stale.append(oneTurnLog())
      const pool = new Pool({ connectionString: databaseUrl() })
      try {
        await pool.query(
          `UPDATE dsh_sessions SET writer_expires_at = now() - interval '1 second' WHERE id = $1`,
          ['fenced'],
        )
      } finally {
        await pool.end()
      }
      const writer = await second.sessionPersistence.open(SessionId('fenced'), 'write')
      const next: SessionEvent[] = [{
        type: 'turn/start', seq: SessionSeq(6), time: 9, data: { turn: 2 },
      }]
      await expect(stale.append(next)).rejects.toBeInstanceOf(SessionOwnershipLostError)
      await writer.append(next)
      await writer.close()
      await stale.close()
    } finally {
      await first.fiber.dispose()
      await second.fiber.dispose()
    }
  })

  it('refuses a database schema newer than this build', async () => {
    const ctx = await mount()
    await ctx.fiber.dispose()
    const pool = new Pool({ connectionString: databaseUrl() })
    try {
      await pool.query('INSERT INTO dsh_schema_migrations (version) VALUES (99)')
    } finally {
      await pool.end()
    }
    try {
      await expect(mount()).rejects.toThrow(/newer than this Harness supports/)
    } finally {
      const cleanup = new Pool({ connectionString: databaseUrl() })
      try {
        await cleanup.query('DELETE FROM dsh_schema_migrations WHERE version = 99')
      } finally {
        await cleanup.end()
      }
    }
  })

  it('serializes concurrent startup migrations', async () => {
    await truncate()
    const contexts = await Promise.all([mount(), mount(), mount()])
    try {
      for (const ctx of contexts) expect(ctx.sessionOwnership.ready()).toBe(true)
    } finally {
      await Promise.all(contexts.map(async ctx => ctx.fiber.dispose()))
    }
  })
})

describeDb('database-backed staff ownership', () => {
  it('reserves the exact id and publishes the committed owner after restart', async () => {
    await truncate()
    const ctx = await mount()
    const release = ctx.sessionOwnership.reserve(SessionId('staff-owned'), 7)
    const handle = await ctx.sessionPersistence.create(meta('staff-owned', '/work'))
    await handle.flush()
    await release()
    expect(ctx.sessionOwnership.ownerOf(SessionId('staff-owned'))).toBe(7)
    expect(ctx.sessionOwnership.sessionsOf(7)).toEqual([SessionId('staff-owned')])
    await expect(ctx.sessionOwnership.verify(SessionId('staff-owned'), 7)).resolves.toBe(true)
    await expect(ctx.sessionOwnership.verify(SessionId('staff-owned'), 8)).resolves.toBe(false)
    await handle.close()
    await ctx.fiber.dispose()

    const restarted = await reopen()
    try {
      expect(restarted.ctx.sessionOwnership.ownerOf(SessionId('staff-owned'))).toBe(7)
    } finally {
      await restarted.dispose()
    }
  })

  it('creates an unowned Session when no reservation was taken', async () => {
    await truncate()
    const ctx = await mount()
    try {
      const handle = await ctx.sessionPersistence.create(meta('unowned', '/work'))
      await handle.flush()
      await handle.close()
      expect(ctx.sessionOwnership.ownerOf(SessionId('unowned'))).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('refuses conflicting reservations and releases a reservation that never creates', async () => {
    await truncate()
    const ctx = await mount()
    try {
      ctx.sessionOwnership.reserve(SessionId('reserved'), 7)
      expect(() => ctx.sessionOwnership.reserve(SessionId('reserved'), 8)).toThrow(/another user/)
      const handle = await ctx.sessionPersistence.create(meta('exists', '/work'))
      await handle.flush()
      await handle.close()
      const release = ctx.sessionOwnership.reserve(SessionId('never-created'), 7)
      await release()
      const other = await ctx.sessionPersistence.create(meta('never-created', '/work'))
      await other.flush()
      await other.close()
      expect(ctx.sessionOwnership.ownerOf(SessionId('never-created'))).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('drops a released reservation so the create stays unowned', async () => {
    await truncate()
    const ctx = await mount()
    try {
      const release = ctx.sessionOwnership.reserve(SessionId('released'), 7)
      await release()
      const handle = await ctx.sessionPersistence.create(meta('released', '/work'))
      await handle.flush()
      await handle.close()
      expect(ctx.sessionOwnership.ownerOf(SessionId('released'))).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describeDb('postgres live write routing', () => {
  it('routes published Session events into the active handle', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(PostgresPersistence, { connectionString: databaseUrl() })
    try {
      const session = ctx.sessions.create(SessionId('routed-postgres'))
      const handle = await ctx.sessionPersistence.create(session.header)
      session.append('turn/start', { turn: 1 })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await expect.poll(async () => (await ctx.sessionPersistence.stat(session.id))?.eventCount).toBe(2)
      await ctx.sessions.flush(session)
      const reader = await ctx.sessionPersistence.open(session.id, 'read')
      expect((await reader.read()).events.map(event => event.type)).toEqual(['turn/start', 'turn/end'])
      await reader.close()
      await handle.close()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describeDb('postgres startup failure', () => {
  it('rejects plugin load when the database refuses the connection', async () => {
    const ctx = new Context()
    await expect(ctx.plugin(PostgresPersistence, {
      connectionString: 'postgresql://127.0.0.1:1/does-not-exist',
      connectionTimeoutMs: 250,
    })).rejects.toThrow()
    await ctx.fiber.dispose()
  })
})

describeDb('90-day chat retention', () => {
  async function backdate(id: string, days: number): Promise<void> {
    const pool = new Pool({ connectionString: databaseUrl() })
    try {
      await pool.query(`UPDATE dsh_sessions SET updated_at = now() - ($2::integer * interval '1 day') WHERE id = $1`, [id, days])
    } finally {
      await pool.end()
    }
  }

  async function eventCount(id: string): Promise<number> {
    const pool = new Pool({ connectionString: databaseUrl() })
    try {
      const result = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM dsh_session_events WHERE session_id = $1', [id])
      return Number(result.rows[0]?.count ?? '0')
    } finally {
      await pool.end()
    }
  }

  it('deletes an expired Session, its events, and its ownership entry', async () => {
    const ctx = await mount({ retentionDays: 90, retentionIntervalMs: 100 })
    try {
      const id = 'retention-expired'
      ctx.sessionOwnership.reserve(SessionId(id), 7)
      const handle = await ctx.sessionPersistence.create(meta(id, '/work'))
      await handle.append(oneTurnLog())
      await handle.close()
      expect(ctx.sessionOwnership.ownerOf(SessionId(id))).toBe(7)
      await backdate(id, 91)

      await expect.poll(async () => ctx.sessionPersistence.stat(SessionId(id)), { timeout: 5_000 }).toBeUndefined()
      expect(ctx.sessionOwnership.ownerOf(SessionId(id))).toBeUndefined()
      await expect.poll(async () => eventCount(id), { timeout: 5_000 }).toBe(0)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps a Session inside the window', async () => {
    const ctx = await mount({ retentionDays: 90, retentionIntervalMs: 100 })
    try {
      const id = 'retention-fresh'
      const handle = await ctx.sessionPersistence.create(meta(id, '/work'))
      await handle.append(oneTurnLog())
      await handle.close()
      await backdate(id, 89)
      await new Promise(resolve => setTimeout(resolve, 400))
      expect(await ctx.sessionPersistence.stat(SessionId(id))).toBeDefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('skips a Session whose writer lease is live', async () => {
    const ctx = await mount({ retentionDays: 90, retentionIntervalMs: 100, leaseMs: 5_000, renewIntervalMs: 1_000 })
    try {
      const id = 'retention-live-writer'
      const handle = await ctx.sessionPersistence.create(meta(id, '/work'))
      await handle.append(oneTurnLog())
      await backdate(id, 91)
      await new Promise(resolve => setTimeout(resolve, 400))
      expect(await ctx.sessionPersistence.stat(SessionId(id))).toBeDefined()
      await handle.close()
      await backdate(id, 91)
      await expect.poll(async () => ctx.sessionPersistence.stat(SessionId(id)), { timeout: 5_000 }).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('runs a sweep at startup before serving', async () => {
    const first = await mount()
    const id = 'retention-startup'
    const handle = await first.sessionPersistence.create(meta(id, '/work'))
    await handle.append(oneTurnLog())
    await handle.close()
    await first.fiber.dispose()
    await backdate(id, 91)

    const second = await mount()
    try {
      expect(await second.sessionPersistence.stat(SessionId(id))).toBeUndefined()
    } finally {
      await second.fiber.dispose()
    }
  })
})
