import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as StaffAccess from '../src/plugin.ts'
import { provideWorkspaceRegistry } from './workspace-registry-stub.ts'

const COOKIE = 'SECRET-COOKIE-222'
const BASE = 'https://django.test'
const INTERVAL = 1_000
const OFFICER_ME = { id: 1, role: 'ADMISSIONS_OFFICER', two_factor_required: false, two_factor_satisfied: false }

let dir: string
let django: { status: number; body: unknown }
let fetchMock: ReturnType<typeof vi.fn>
const roots: Context[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'staff-revocation-'))
  django = { status: 200, body: OFFICER_ME }
  fetchMock = vi.fn(async () => new Response(JSON.stringify(django.body), { status: django.status }))
  vi.stubGlobal('fetch', fetchMock)
  vi.useFakeTimers()
})

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.useRealTimers()
  vi.unstubAllGlobals()
  rmSync(dir, { recursive: true, force: true })
})

/** Host with the Remote access service, fake Connection and agents, and the staff plugin mounted. */
async function mount(extra: Partial<StaffAccess.Config> = {}) {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(RemoteAccessService)
  const connection = { disposeExternalPeer: vi.fn() }
  ctx.provide('connection', connection as never)
  ctx.provide('agents', { get: () => undefined } as never)
  provideWorkspaceRegistry(ctx)
  const fiber = ctx.plugin(StaffAccess, {
    ownersFile: join(dir, 'owners.json'),
    djangoBaseUrl: BASE,
    workspaceDir: join(dir, 'workspace'),
    sweepIntervalMs: INTERVAL,
    ...extra,
  })
  await fiber
  return { ctx, connection, fiber }
}

async function admitCookie(ctx: Context) {
  return ctx.externalPeerAdmission.admit({ cookie: `sessionid=${COOKIE}` })
}

describe('staff revocation sweep on the mounted plugin', () => {
  it.each<[string, { status: number; body: unknown }]>([
    ['401', { status: 401, body: {} }],
    ['403', { status: 403, body: {} }],
    ['two-factor incomplete', { status: 200, body: { ...OFFICER_ME, two_factor_required: true, two_factor_satisfied: false } }],
    ['a non-admissions role', { status: 200, body: { ...OFFICER_ME, role: 'STUDENT' } }],
    ['a Django 500', { status: 500, body: {} }],
  ])('revokes within one interval after Django answers %s', async (_label, answer) => {
    const { ctx, connection } = await mount()
    expect(await admitCookie(ctx)).toMatchObject({ kind: 'allow', key: 'staff:1' })
    django = answer
    await vi.advanceTimersByTimeAsync(INTERVAL)
    expect(connection.disposeExternalPeer).toHaveBeenCalledWith('staff:1')
  })

  it('keeps an allowed user across sweeps', async () => {
    const { ctx, connection } = await mount()
    await admitCookie(ctx)
    await vi.advanceTimersByTimeAsync(INTERVAL * 3)
    expect(connection.disposeExternalPeer).not.toHaveBeenCalled()
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(4)
  })

  it('makes no Django call while no cookie is held', async () => {
    await mount()
    await vi.advanceTimersByTimeAsync(INTERVAL * 3)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('stops sweeping once the plugin is disposed', async () => {
    const { ctx, fiber } = await mount()
    await admitCookie(ctx)
    await fiber.dispose()
    const before = fetchMock.mock.calls.length
    await vi.advanceTimersByTimeAsync(INTERVAL * 3)
    expect(fetchMock.mock.calls.length).toBe(before)
  })
})

describe('staff access plugin configuration', () => {
  it.each<[string, Record<string, unknown>, string]>([
    ['a missing djangoBaseUrl', { djangoBaseUrl: undefined }, 'djangoBaseUrl must be an http or https origin'],
    ['a non-http scheme', { djangoBaseUrl: 'ftp://django.test' }, 'djangoBaseUrl must be an http or https origin'],
    ['a path', { djangoBaseUrl: 'https://django.test/api' }, 'djangoBaseUrl must be an http or https origin'],
    ['a query', { djangoBaseUrl: 'https://django.test/?x=1' }, 'djangoBaseUrl must be an http or https origin'],
    ['credentials', { djangoBaseUrl: 'https://user:pw@django.test' }, 'djangoBaseUrl must be an http or https origin'],
    ['an unparseable URL', { djangoBaseUrl: 'not a url' }, 'djangoBaseUrl must be an http or https origin'],
    ['an empty role list', { roles: [] }, 'roles must be a non-empty list of role names'],
    ['an empty role name', { roles: [''] }, 'roles must be a non-empty list of role names'],
    ['a cookie name with a space', { cookieName: 'session id' }, 'cookieName must use only'],
    ['a zero TTL', { ttlMs: 0 }, 'ttlMs must be a positive whole number'],
    ['a fractional sweep interval', { sweepIntervalMs: 1.5 }, 'sweepIntervalMs must be a positive whole number'],
    ['a sweep interval beyond the timer limit', { sweepIntervalMs: 2 ** 31 }, 'sweepIntervalMs must be a positive whole number'],
  ])('refuses %s at load', async (_label, override, message) => {
    const ctx = new Context()
    roots.push(ctx)
    const config = { ownersFile: join(dir, 'owners.json'), djangoBaseUrl: BASE, ...override }
    expect(() => { StaffAccess.apply(ctx, config) }).toThrow(message)
  })

  it('accepts an origin with a trailing slash and applies the defaults', async () => {
    const { ctx } = await mount({ djangoBaseUrl: 'https://django.test/' })
    expect(await admitCookie(ctx)).toMatchObject({ kind: 'allow' })
  })
})
