import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { McpHeaders } from '@deepseek-ai/dsh-mcp-client'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as StaffAccess from '../src/plugin.ts'
import { provideWorkspaceRegistry } from './workspace-registry-stub.ts'

const COOKIE = 'COOKIE-PLUGIN-secret'
const BASE = 'https://django.test'
const ME = { id: 7, role: 'ADMISSIONS_OFFICER', two_factor_required: false, two_factor_satisfied: false }

let dir: string
let meStatus = 200
let fetchMock: ReturnType<typeof vi.fn>
const roots: Context[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'staff-ai-token-'))
  meStatus = 200
  fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith('/users/me/')) return new Response(JSON.stringify(ME), { status: meStatus })
    if (url.endsWith('/users/csrf-token/')) return new Response('{"csrfToken":"CSRF-x"}', { headers: { 'set-cookie': 'csrftoken=CSRFC-x; Path=/' } })
    return new Response('{"token":"TOK-plugin","expires_in":900}')
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

async function mount(extra: Partial<StaffAccess.Config> = {}) {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(RemoteAccessService)
  const connection = { disposeExternalPeer: vi.fn() }
  ctx.provide('connection', connection as never)
  ctx.provide('agents', { get: () => undefined } as never)
  provideWorkspaceRegistry(ctx)
  await ctx.plugin(StaffAccess, { ownersFile: join(dir, 'owners.json'), djangoBaseUrl: BASE, workspaceDir: join(dir, 'workspace'), ...extra })
  ctx.staffSessions.owners.record(SessionId('s1'), 7)
  await ctx.externalPeerAdmission.admit({ cookie: `sessionid=${COOKIE}` })
  fetchMock.mockClear()
  return ctx
}

type Exec = Parameters<McpHeaders['headersFor']>[1]
const exec = (id: string): Exec => ({ agent: { id } }) as Exec
const mints = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/ai/token/')).length

describe('mcpHeaders service of the staff plugin', () => {
  it('returns a bearer header for the tool server only', async () => {
    const ctx = await mount()
    expect(await ctx.mcpHeaders?.headersFor('cinhed', exec('s1'))).toEqual({ Authorization: 'Bearer TOK-plugin' })
    fetchMock.mockClear()
    expect(await ctx.mcpHeaders?.headersFor('other', exec('s1'))).toEqual({})
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('honours toolServerName and validates it', async () => {
    const ctx = await mount({ toolServerName: 'tools' })
    expect(await ctx.mcpHeaders?.headersFor('cinhed', exec('s1'))).toEqual({})
    expect(await ctx.mcpHeaders?.headersFor('tools', exec('s1'))).toEqual({ Authorization: 'Bearer TOK-plugin' })
    expect(() => { StaffAccess.apply(new Context(), { ownersFile: join(dir, 'o.json'), djangoBaseUrl: BASE, toolServerName: 'a b' }) })
      .toThrow('staff-access: toolServerName must use only')
  })

  it('refuses a session with no owner without calling Django', async () => {
    const ctx = await mount()
    await expect(ctx.mcpHeaders?.headersFor('cinhed', exec('nobody'))).rejects.toThrow('staff-access: sign in again')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a call that has no Agent without calling Django', async () => {
    const ctx = await mount()
    await expect(ctx.mcpHeaders?.headersFor('cinhed', {} as Exec)).rejects.toThrow('staff-access: sign in again')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('mints no new token for a revoked user and forgets the cached one', async () => {
    const ctx = await mount({ ttlMs: 1 })
    await ctx.mcpHeaders?.headersFor('cinhed', exec('s1'))
    await ctx.mcpHeaders?.headersFor('cinhed', exec('s1'))
    expect(mints()).toBe(1)
    // Django now denies the held session: the admission revokes the user, which drops the cached token.
    meStatus = 403
    await new Promise((resolve) => { setTimeout(resolve, 10) }) // let the 1 ms allow decision expire
    expect(await ctx.externalPeerAdmission.admit({ cookie: `sessionid=${COOKIE}` })).toEqual({ kind: 'deny' })
    fetchMock.mockClear()
    await expect(ctx.mcpHeaders?.headersFor('cinhed', exec('s1'))).rejects.toThrow('staff-access: sign in again')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('never writes the token, cookie or CSRF value to a logger on the failure path', async () => {
    const ctx = await mount()
    const spies = (['error', 'warn', 'info', 'debug'] as const).map(level => vi.spyOn(ctx.logger, level))
    fetchMock.mockResolvedValue(new Response('{"detail":"TOK-plugin COOKIE-PLUGIN-secret CSRF-x"}', { status: 500 }))
    const error: unknown = await Promise.resolve(ctx.mcpHeaders?.headersFor('cinhed', exec('s1'))).catch((e: unknown) => e)
    expect((error as Error).message).toBe('staff-access: sign in again')
    for (const spy of spies) expect(JSON.stringify(spy.mock.calls as unknown[])).not.toMatch(/TOK-plugin|COOKIE-PLUGIN|CSRF-x/)
  })
})
