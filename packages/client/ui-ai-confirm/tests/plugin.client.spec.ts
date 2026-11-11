/**
 * ui-ai-confirm browser half: one keyed card per prepare tool, the dictionaries, the injected faces,
 * the deployment settings, and removal of every registration when the plugin fiber is disposed
 * (hot-reload safety).
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { apply, Config, inject } from '../src/client/index.ts'
import { CardNode } from '../src/client/CardNode.tsx'
import { en, zh } from '../src/client/locales.ts'

interface Presentation {
  readonly slots: SlotRegistry
  readonly cardDefinitions: unknown[]
  readonly dictionaries: { namespace: string; dictionaries: unknown }[]
  disposed: boolean
}

/** Provide the slot registry with the toolview slot declared, and a locale registry that records registrations. */
function providePresentation(ctx: Context): Presentation {
  const slots = new SlotRegistry(ctx)
  slots.register({
    name: 'root',
    children: {
      'tool.call.toolview': { kind: 'keyed', scope: 'session' },
      'conversation.chat.node': { kind: 'keyed', scope: 'session' },
    },
  } as never, () => null)
  const presentation: Presentation = { slots, cardDefinitions: [], dictionaries: [], disposed: false }
  ctx.provide('uiConversation', {
    events: { register(definition: unknown) {
      presentation.cardDefinitions.push(definition)
      return () => { presentation.cardDefinitions.splice(presentation.cardDefinitions.indexOf(definition), 1) }
    } },
  })
  ctx.provide('locale', {
    register(namespace: string, dictionaries: unknown) {
      presentation.dictionaries.push({ namespace, dictionaries })
      return () => { presentation.disposed = true }
    },
  })
  return presentation
}

/** Boots the plugin; with no config it passes none, as a real client row does. */
async function boot(config?: Record<string, unknown>) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  const presentation = providePresentation(ctx)
  const fiber = config === undefined
    ? ctx.plugin({ inject: [...inject], apply, Config })
    : ctx.plugin({ inject: [...inject], apply, Config }, config)
  await fiber.await()
  return { ctx, presentation, fiber }
}

describe('apply', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['slots', 'locale', 'uiConversation'])
  })

  it('registers one keyed card per prepare tool, named by the MCP server', async () => {
    const { presentation } = await boot({ serverName: 'cinhed' })

    const entries = presentation.slots.entries('tool.call.toolview')

    expect(entries.map(entry => entry.options.key)).toEqual([
      'mcp__cinhed__prepare_approve',
      'mcp__cinhed__prepare_reject',
      'mcp__cinhed__prepare_request_documents',
      'mcp__cinhed__prepare_cancel',
      'mcp__cinhed__prepare_verify_document',
      'mcp__cinhed__prepare_reject_document',
      'mcp__cinhed__prepare_enroll',
      'mcp__cinhed__prepare_send_offer',
      'mcp__cinhed__list_applications',
      'mcp__cinhed__get_application',
      'mcp__cinhed__open_application_form',
      'mcp__cinhed__open_offer_form',
    ])
    for (const entry of entries) {
      expect(typeof entry.component).toBe('function')
      expect(entry.locale).toBeUndefined()
      expect(entry.store).toBeUndefined()
      expect(entry.inject).toBeUndefined()
      const component = entry.component as () => null
      expect(component()).toBeNull()
    }
    const node = presentation.slots.entries('conversation.chat.node')
    expect(node).toHaveLength(1)
    expect(node[0]?.options.key).toBe('ai-confirm-card')
    expect(node[0]?.component).toBe(CardNode)
    expect(node[0]?.locale).toBe('aiConfirm')
    expect(presentation.cardDefinitions).toHaveLength(1)
    expect(presentation.cardDefinitions[0]).toMatchObject({ kind: 'ai-confirm-card', target: 'chat' })
  })

  it('follows the configured server name', async () => {
    const { presentation } = await boot({ serverName: 'school_ai' })

    const keys = presentation.slots.entries('tool.call.toolview').map(entry => entry.options.key)
    expect(keys[0]).toBe('mcp__school_ai__prepare_approve')
    expect(keys.slice(8)).toEqual([
      'mcp__school_ai__list_applications', 'mcp__school_ai__get_application',
      'mcp__school_ai__open_application_form', 'mcp__school_ai__open_offer_form',
    ])
  })

  it('shares one store and the API faces on the Chat node', async () => {
    const { presentation } = await boot({ serverName: 'cinhed', signInUrl: '/staff/login' })
    const entry = presentation.slots.entries('conversation.chat.node')[0]!
    const make = entry.inject as never as () => { api: object; serverName: string; signInUrl: string }
    const injected = make()

    expect(entry.store).toBeDefined()
    expect(injected).toMatchObject({ serverName: 'cinhed', signInUrl: '/staff/login' })
    expect(typeof (injected.api as { claim: unknown }).claim).toBe('function')
    expect(presentation.slots.entries('tool.call.toolview').every(toolEntry => toolEntry.store === undefined)).toBe(true)
  })

  it('registers the zh and en dictionaries', async () => {
    const { presentation } = await boot({ serverName: 'cinhed' })

    expect(presentation.dictionaries).toEqual([{ namespace: 'aiConfirm', dictionaries: { zh, en } }])
  })

  it('removes every registration when the plugin is disposed (hot-reload safety)', async () => {
    const { presentation, fiber } = await boot({ serverName: 'cinhed' })
    expect(presentation.slots.entries('tool.call.toolview')).toHaveLength(12)
    expect(presentation.slots.entries('conversation.chat.node')).toHaveLength(1)
    expect(presentation.cardDefinitions).toHaveLength(1)

    await fiber.dispose()

    expect(presentation.slots.entries('tool.call.toolview')).toHaveLength(0)
    expect(presentation.slots.entries('conversation.chat.node')).toHaveLength(0)
    expect(presentation.cardDefinitions).toHaveLength(0)
    expect(presentation.disposed).toBe(true)
  })

  it('calls the page fetch at the moment of each request', async () => {
    const { presentation } = await boot({ serverName: 'cinhed' })
    const calls: string[] = []
    // The card's api calls fetch with a path string, so the stub reads it as one.
    vi.stubGlobal('fetch', async (input: string) => {
      calls.push(input)
      return new Response(JSON.stringify({ id: 'x' }), { status: 410 })
    })
    onTestFinished(() => { vi.unstubAllGlobals() })
    const make = presentation.slots.entries('conversation.chat.node')[0]?.inject as never as () => {
      api: { claim: (id: string) => Promise<void> }
    }
    await make().api.claim('abc').catch(() => undefined)

    expect(calls).toEqual(['/tools/pending/abc/consume'])
  })

  it('runs with no config at all, as a real client row does', async () => {
    const { presentation } = await boot()

    expect(presentation.slots.entries('tool.call.toolview').map(entry => entry.options.key)).toEqual([
      'mcp__cinhed__prepare_approve',
      'mcp__cinhed__prepare_reject',
      'mcp__cinhed__prepare_request_documents',
      'mcp__cinhed__prepare_cancel',
      'mcp__cinhed__prepare_verify_document',
      'mcp__cinhed__prepare_reject_document',
      'mcp__cinhed__prepare_enroll',
      'mcp__cinhed__prepare_send_offer',
      'mcp__cinhed__list_applications',
      'mcp__cinhed__get_application',
      'mcp__cinhed__open_application_form',
      'mcp__cinhed__open_offer_form',
    ])
  })
})

describe('Config', () => {
  it('fills every setting with its default', () => {
    expect(Config({})).toMatchObject({
      serverName: 'cinhed',
      toolsPath: '/tools/pending',
      apiPath: '/api/v1',
      signInUrl: '/login',
    })
  })

  it('keeps the settings it is given', () => {
    expect(Config({ serverName: 'school_ai' })).toMatchObject({
      serverName: 'school_ai',
      toolsPath: '/tools/pending',
    })
  })

  it.each([
    ['a server name with a space', { serverName: 'my server' }],
    ['a server name that is too long', { serverName: 'x'.repeat(33) }],
    ['an empty server name', { serverName: '' }],
    ['a tool path on another origin', { serverName: 'a', toolsPath: 'https://evil.example/tools' }],
    ['an API path with no leading slash', { serverName: 'a', apiPath: 'api/v1' }],
    ['a sign-in URL on another origin', { serverName: 'a', signInUrl: 'https://evil.example/login' }],
    ['a sign-in URL that is protocol-relative', { serverName: 'a', signInUrl: '//evil.example/login' }],
    ['a path with a query', { serverName: 'a', signInUrl: '/login?next=//evil.example' }],
  ])('rejects %s', (_label, config) => {
    expect(() => Config(config as never)).toThrow()
  })
})
