/** Per-call HTTP headers from the optional `mcpHeaders` service, against the real HTTP fixture. */
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { fetchWithCallHeaders, withCallHeaders } from '@deepseek-ai/dsh-mcp-client/src/headers.ts'
import { apply } from '@deepseek-ai/dsh-mcp-client/src/index.ts'
import type { Config, McpHeaders } from '@deepseek-ai/dsh-mcp-client'
import { startHttpMcpFixture, type HttpMcpFixture } from './http-fixture.ts'

const signal = new AbortController().signal
let seq = 0
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const c of cleanups.splice(0)) await c() })

async function mount(provider?: McpHeaders): Promise<{ ctx: Context; fixture: HttpMcpFixture }> {
  const fixture = await startHttpMcpFixture()
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  if (provider !== undefined) ctx.provide('mcpHeaders', provider)
  const config: Config = {
    transport: 'streamable-http',
    serverName: 'web',
    url: fixture.url,
    headers: { Authorization: 'Bearer static' },
    toolCallTimeoutMs: 15_000,
    failOnStartupError: true,
  }
  await apply(ctx, config)
  cleanups.push(async () => { await ctx.fiber.dispose(); await fixture.close() })
  return { ctx, fixture }
}

/** Fake calling agent; the provider keys on `id`. */
const agent = (id: string): never => ({ id }) as never
const call = (ctx: Context, id: string, args: object = {}): ReturnType<typeof executeToolFixture> => executeToolFixture(ctx, {
  signal, callId: ToolCallId(`ch-${++seq}`), name: 'mcp__web__whoami', arguments: args, agent: agent(id),
})
const textOf = (r: Awaited<ReturnType<typeof call>>): string => (r.content[0] as { text: string }).text
const byAgent: McpHeaders = {
  headersFor: (_server, exec) => ({ Authorization: `Bearer for-${(exec.agent as unknown as { id: string }).id}` }),
}

describe('mcpHeaders per-call headers', () => {
  it('gives concurrent calls from different agents their own headers', async () => {
    const { ctx } = await mount(byAgent)
    const ids = Array.from({ length: 40 }, (_, i) => `a${i % 2 === 0 ? 'A' : 'B'}${i}`)
    const results = await Promise.all(ids.map(id => call(ctx, id)))
    results.forEach((r, i) => { expect(textOf(r)).toBe(`Bearer for-${ids[i]}`) })
  })

  it('sends only static headers on connect and listTools', async () => {
    const { fixture } = await mount(byAgent)
    expect(fixture.authorization.length).toBeGreaterThan(0)
    for (const a of fixture.authorization) expect(a).toBe('Bearer static')
  })

  it('is unchanged without the service', async () => {
    const { ctx } = await mount()
    expect(textOf(await call(ctx, 'x'))).toBe('Bearer static')
  })

  it('fails only that call and sends no request when the provider throws', async () => {
    const { ctx, fixture } = await mount({
      headersFor: (_s, exec) => {
        if ((exec.agent as unknown as { id: string }).id === 'bad') throw new Error('no session token for bad')
        return { Authorization: 'Bearer SECRET-ok' }
      },
    })
    const before = fixture.authorization.length
    const failed = await call(ctx, 'bad')
    expect(failed.isError).toBe(true)
    expect(JSON.stringify(failed)).toContain('no session token for bad')
    expect(JSON.stringify(failed)).not.toContain('SECRET')
    expect(fixture.authorization.length).toBe(before)
    expect(textOf(await call(ctx, 'good'))).toBe('Bearer SECRET-ok')
  })

  it('lets provider headers override a static Authorization', async () => {
    const { ctx } = await mount({ headersFor: () => ({ Authorization: 'Bearer override' }) })
    expect(textOf(await call(ctx, 'x'))).toBe('Bearer override')
  })

  it('does not leak a slow call headers into a concurrent call', async () => {
    const { ctx } = await mount(byAgent)
    const slow = call(ctx, 'slow', { delayMs: 300 })
    const fast = await call(ctx, 'fast')
    expect(textOf(fast)).toBe('Bearer for-fast')
    expect(textOf(await slow)).toBe('Bearer for-slow')
  })
})

describe('fetchWithCallHeaders method gating', () => {
  async function seenBy(method: string | undefined, inStore: boolean): Promise<string | undefined> {
    const seen: Array<string | undefined> = []
    const server = createServer((req, res) => { seen.push(req.headers.authorization); res.end('ok') })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const { port } = server.address() as { port: number }
      const send = (): Promise<Response> => fetchWithCallHeaders(`http://127.0.0.1:${port}/`, {
        ...method === undefined ? {} : { method }, headers: { Authorization: 'Bearer static' },
      })
      await (inStore ? withCallHeaders({ Authorization: 'Bearer overlay' }, send) : send())
    } finally {
      await new Promise<void>(resolve => server.close(() => { resolve() }))
    }
    return seen[0]
  }

  it('overlays on POST inside a store', async () => { expect(await seenBy('POST', true)).toBe('Bearer overlay') })
  it('keeps static headers on GET inside a store (stream reconnect)', async () => { expect(await seenBy('GET', true)).toBe('Bearer static') })
  it('treats a missing method as GET', async () => { expect(await seenBy(undefined, true)).toBe('Bearer static') })
  it('keeps static headers on DELETE inside a store', async () => { expect(await seenBy('DELETE', true)).toBe('Bearer static') })
  it('sends static headers on POST outside a store', async () => { expect(await seenBy('POST', false)).toBe('Bearer static') })
})
