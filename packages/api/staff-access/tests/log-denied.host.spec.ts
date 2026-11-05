import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import { SessionId } from '@deepseek-ai/dsh-session'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'
import * as StaffAccess from '../src/plugin.ts'
import { provideWorkspaceRegistry } from './workspace-registry-stub.ts'
import { staffPrincipal } from '../src/index.ts'

const STAFF = staffPrincipal({ userId: 1, role: 'ADMISSIONS_OFFICER' })
const OTHER = staffPrincipal({ userId: 2, role: 'ADMISSIONS_OFFICER' })
const GLOBAL = { kind: 'global' } as const
const DENIED = 'dynamicCordisRunner/inventory'
const LINE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z staff-access: denied (\S+) for user (\d+)( on \S+)?\n$/

let dir: string
let stderr: MockInstance<typeof process.stderr.write>
const roots: Context[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'staff-log-denied-'))
  stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
})

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

/** Every chunk written to stderr so far, as text. */
function written(): string[] {
  return stderr.mock.calls.map(call => String(call[0]))
}

async function setup(config: Partial<StaffAccess.Config> = {}): Promise<Context> {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(RemoteAccessService)
  provideWorkspaceRegistry(ctx)
  await ctx.plugin(StaffAccess, { ownersFile: join(dir, 'owners.json'), djangoBaseUrl: 'https://django.test', workspaceDir: join(dir, 'workspace'), ...config })
  return ctx
}

describe('staff access denial logging', () => {
  it('prints one line per new method and user', async () => {
    const ctx = await setup({ logDenied: true })
    ctx.remoteAccess.decide({ principal: STAFF, action: DENIED, resources: [GLOBAL] })
    ctx.remoteAccess.decide({ principal: STAFF, action: DENIED, resources: [GLOBAL] })
    ctx.remoteAccess.decide({ principal: OTHER, action: DENIED, resources: [GLOBAL] })
    const lines = written()
    expect(lines).toHaveLength(2)
    expect(lines.every(line => LINE.test(line))).toBe(true)
    expect(lines.map(line => line.match(LINE)?.slice(1, 3))).toEqual([[DENIED, '1'], [DENIED, '2']])
    expect(lines.every(line => line.endsWith(' on global\n'))).toBe(true)
  })

  it('names the refused resource and prints each refused resource once', async () => {
    const ctx = await setup({ logDenied: true })
    const other = SessionId('theirs')
    ctx.remoteAccess.decide({ principal: STAFF, action: 'session/prompt', resources: [{ kind: 'session', id: other }] })
    ctx.remoteAccess.decide({ principal: STAFF, action: 'session/prompt', resources: [{ kind: 'session', id: other }] })
    ctx.remoteAccess.decide({ principal: STAFF, action: 'session/prompt', resources: [{ kind: 'session', id: SessionId('second') }] })
    expect(written()).toEqual([
      expect.stringMatching(/ staff-access: denied session\/prompt for user 1 on session:theirs\n$/),
      expect.stringMatching(/ staff-access: denied session\/prompt for user 1 on session:second\n$/),
    ])
  })

  it('prints nothing when the option is off', async () => {
    const ctx = await setup()
    ctx.remoteAccess.decide({ principal: STAFF, action: DENIED, resources: [GLOBAL] })
    expect(written()).toHaveLength(0)
  })

  it('registers its exporter only when the option is on', async () => {
    const base = new Context().logger.exporters.size
    const off = await setup()
    expect(off.logger.exporters.size).toBe(base)
    const on = await setup({ logDenied: true })
    expect(on.logger.exporters.size).toBe(base + 1)
  })

  it('removes its exporter when the plugin is disposed', async () => {
    const ctx = new Context()
    roots.push(ctx)
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(RemoteAccessService)
    const before = ctx.logger.exporters.size
    provideWorkspaceRegistry(ctx)
    const fiber = ctx.plugin(StaffAccess, { ownersFile: join(dir, 'owners.json'), djangoBaseUrl: 'https://django.test', workspaceDir: join(dir, 'workspace'), logDenied: true })
    await fiber
    expect(ctx.logger.exporters.size).toBe(before + 1)
    await fiber.dispose()
    expect(ctx.logger.exporters.size).toBe(before)
  })

  it('never writes arguments or cookie text', async () => {
    const ctx = await setup({ logDenied: true })
    ctx.remoteAccess.decide({
      principal: STAFF,
      action: DENIED,
      resources: [GLOBAL],
      args: { prompt: 'PAYLOAD-TEXT', cookie: 'sessionid=SECRET-COOKIE' },
    })
    const text = written().join('')
    expect(text).toMatch(LINE)
    expect(text).not.toMatch(/PAYLOAD-TEXT|SECRET-COOKIE|sessionid/)
  })

  it('does not print the owner', async () => {
    const ctx = await setup({ logDenied: true })
    ctx.emit('remote-access/denied', { kind: 'owner' }, DENIED)
    expect(written()).toHaveLength(0)
  })

  it('does not print other loggers', async () => {
    const ctx = await setup({ logDenied: true })
    ctx.logger('other-plugin').info('OTHER-LINE')
    expect(written()).toHaveLength(0)
  })

  it('bounds the remembered pairs and forgets the oldest first', async () => {
    const ctx = await setup({ logDenied: true })
    for (let index = 0; index <= 2000; index++) {
      ctx.emit('remote-access/denied', STAFF, `x/m${index}`)
    }
    expect(written()).toHaveLength(2001)
    ctx.emit('remote-access/denied', STAFF, 'x/m2000')
    expect(written()).toHaveLength(2001)
    ctx.emit('remote-access/denied', STAFF, 'x/m0')
    expect(written()).toHaveLength(2002)
  })

  it('rejects a non-boolean switch when the plugin mounts', async () => {
    const ctx = new Context()
    roots.push(ctx)
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(RemoteAccessService)
    expect(() => {
      StaffAccess.apply(ctx, { ownersFile: join(dir, 'owners.json'), djangoBaseUrl: 'https://django.test', workspaceDir: join(dir, 'workspace'), logDenied: 'yes' as unknown as boolean })
    }).toThrow('staff-access: logDenied must be true or false')
  })
})
