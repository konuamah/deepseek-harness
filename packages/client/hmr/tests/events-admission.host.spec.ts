/**
 * Host face of the HMR events channel: the /plugins/events admission gate
 * (Host fence, owner cookie, external Peer provider) before the SSE stream opens.
 */
import { EventEmitter } from 'node:events'
import type { ServerResponse, IncomingMessage } from 'node:http'
import { statSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { ClientArtifactBaseline, ClientModuleRegistry, WebBootGraph } from '@deepseek-ai/dsh-client-modules'
import type { HostConnectionHandle, ExternalPeerAdmission, PeerAdmission } from '@deepseek-ai/dsh-client-connection'
import type { WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver'
import { apply, Config, inject } from '../src/index.ts'

const POLL_MS = 20

/**
 * Controllable clientModuleHost fake over a mutable id → bundle-path table.
 * Structural (Pick+cast): the plugin only touches the read/notify surface;
 * the service class carries private scan state a literal need not reproduce.
 */
type FakeHost = ClientModuleRegistry & { rebuiltCalls: string[]; fireGraphChanged(): void }
interface FakeHostOptions {
  beforeGraphRead?: () => void
  rebuilt?: (id: string) => string | undefined
}

function artifactBaseline(path: string): ClientArtifactBaseline {
  const bundle = statSync(path)
  return { path, mtimeMs: bundle.mtimeMs, ctimeMs: bundle.ctimeMs, size: bundle.size }
}

function fakeClientModuleHost(rows: Map<string, string>, options: FakeHostOptions = {}): FakeHost {
  const graphListeners = new Set<() => void>()
  const rebuiltCalls: string[] = []
  const baselines = new Map([...rows].map(([id, path]) => [id, artifactBaseline(path)]))
  const fake: Pick<FakeHost, 'graph' | 'artifactBaseline' | 'rebuilt' | 'onRebuilt' | 'onGraphChanged' | 'rebuiltCalls' | 'fireGraphChanged'> = {
    rebuiltCalls,
    fireGraphChanged: () => { for (const l of graphListeners) l() },
    graph: (): WebBootGraph => {
      options.beforeGraphRead?.()
      return {
        rev: 'r',
        entries: [...rows.keys()].map(id => ({ id, url: `plugins/??${id}/client.js&rev=r`, rev: 'r' })),
        batches: [],
      }
    },
    artifactBaseline: (id) => {
      const path = rows.get(id)
      if (path === undefined) return undefined
      let baseline = baselines.get(id)
      if (baseline?.path !== path) {
        baseline = artifactBaseline(path)
        baselines.set(id, baseline)
      }
      return { ...baseline }
    },
    rebuilt: (id) => {
      rebuiltCalls.push(id)
      return options.rebuilt?.(id) ?? 'r2'
    },
    onRebuilt: () => () => {},
    onGraphChanged: (listener) => {
      graphListeners.add(listener)
      return () => { graphListeners.delete(listener) }
    },
  }
  return fake as FakeHost
}

// Structural fake: the plugin only touches register(); the service class
// carries private state a literal cannot (and need not) reproduce.
function fakeHttpServer(routes: WebRoute[]): WebServer {
  const fake: Pick<WebServer, 'register' | 'tapIndex' | 'port'> = {
    register(route: WebRoute) {
      routes.push(route)
      return () => { routes.splice(routes.indexOf(route), 1) }
    },
    tapIndex: () => () => {},
    port: 0,
  }
  return fake as WebServer
}

describe('hmr events admission', () => {
  /** Connection fake that follows admitAsync's order: Host fence, owner cookie, then the external provider. */
  function fakeConnection(ctx: Context): HostConnectionHandle {
    const fake = {
      admitAsync: async (request: IncomingMessage): Promise<PeerAdmission> => {
        if (request.headers.host !== 'localhost') return { rejection: 403 }
        if (request.headers.cookie === 'owner=1') return { peer: 'owner' as never }
        const provider = ctx.get('externalPeerAdmission')
        if (provider === undefined) return { rejection: 401 }
        try {
          const decision = await provider.admit(request.headers)
          return decision.kind === 'allow' ? { peer: 'external' as never } : { rejection: 401 }
        } catch {
          return { rejection: 401 }
        }
      },
    }
    return fake as never
  }

  async function mountEvents(options: { provider?: ExternalPeerAdmission; connection?: boolean }) {
    const ctx = new Context()
    const routes: WebRoute[] = []
    ctx.provide('clientModules', fakeClientModuleHost(new Map()))
    ctx.provide('webServer', fakeHttpServer(routes))
    if (options.provider !== undefined) ctx.provide('externalPeerAdmission', options.provider)
    if (options.connection !== false) ctx.provide('connection', fakeConnection(ctx))
    const fiber = ctx.plugin({ inject: [...inject], Config, apply }, { pollIntervalMs: POLL_MS })
    await fiber.await()
    return { fiber, route: routes[0]! }
  }

  /** Invoke the events route with a Host and optional cookie, returning the response fake. */
  async function requestEvents(route: WebRoute, headers: Record<string, string>, method = 'GET') {
    const lines: string[] = []
    const response = Object.assign(new EventEmitter(), {
      writeHead: vi.fn(), write: (line: string) => { lines.push(line) },
      destroy: vi.fn(), end: vi.fn(),
    })
    void route.handler({ method, headers } as unknown as IncomingMessage, response as unknown as ServerResponse)
    await vi.waitFor(() => { expect(response.writeHead).toHaveBeenCalled() })
    return { lines, response }
  }

  const denyAll: ExternalPeerAdmission = { admit: vi.fn(async () => ({ kind: 'deny' as const })) }
  const allowAll: ExternalPeerAdmission = {
    admit: vi.fn(async () => ({ kind: 'allow' as const, key: 'staff:42', principal: { kind: 'staff', id: '42' } as never })),
  }

  it('opens the stream without admission when no external provider is provided', async () => {
    const { fiber, route } = await mountEvents({})
    try {
      const { lines, response } = await requestEvents(route, { host: 'localhost' })
      expect(response.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ 'content-type': 'text/event-stream' }))
      expect(lines[0]).toBe(': connected\n\n')
    } finally {
      await fiber.dispose()
    }
  })

  it('answers 405 for non-GET requests even when a provider is present', async () => {
    const { fiber, route } = await mountEvents({ provider: denyAll })
    try {
      const { response } = await requestEvents(route, { host: 'localhost' }, 'POST')
      expect(response.writeHead).toHaveBeenCalledWith(405)
    } finally {
      await fiber.dispose()
    }
  })

  it('refuses the stream with 401 when the provider denies and no owner cookie is sent', async () => {
    const { fiber, route } = await mountEvents({ provider: denyAll })
    try {
      const { lines, response } = await requestEvents(route, { host: 'localhost' })
      expect(response.writeHead).toHaveBeenCalledWith(401)
      expect(response.writeHead).toHaveBeenCalledTimes(1)
      expect(lines).toEqual([])
    } finally {
      await fiber.dispose()
    }
  })

  it('opens the stream for the owner cookie without calling the provider', async () => {
    const provider = { admit: vi.fn(async () => ({ kind: 'deny' as const })) }
    const { fiber, route } = await mountEvents({ provider })
    try {
      const { lines, response } = await requestEvents(route, { host: 'localhost', cookie: 'owner=1' })
      expect(response.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ 'content-type': 'text/event-stream' }))
      expect(lines[0]).toBe(': connected\n\n')
      expect(provider.admit).not.toHaveBeenCalled()
    } finally {
      await fiber.dispose()
    }
  })

  it('opens the stream for an external Peer the provider allows', async () => {
    const { fiber, route } = await mountEvents({ provider: allowAll })
    try {
      const { lines, response } = await requestEvents(route, { host: 'localhost' })
      expect(response.writeHead).toHaveBeenCalledWith(200, expect.objectContaining({ 'content-type': 'text/event-stream' }))
      expect(lines[0]).toBe(': connected\n\n')
    } finally {
      await fiber.dispose()
    }
  })

  it('refuses a request with a bad Host with 403 and opens no stream', async () => {
    const { fiber, route } = await mountEvents({ provider: allowAll })
    try {
      const { lines, response } = await requestEvents(route, { host: 'evil.example' })
      expect(response.writeHead).toHaveBeenCalledWith(403)
      expect(lines).toEqual([])
    } finally {
      await fiber.dispose()
    }
  })

  it('refuses the stream with 401 when the provider throws', async () => {
    const throwing: ExternalPeerAdmission = { admit: vi.fn(async () => { throw new Error('down') }) }
    const { fiber, route } = await mountEvents({ provider: throwing })
    try {
      const { lines, response } = await requestEvents(route, { host: 'localhost' })
      expect(response.writeHead).toHaveBeenCalledWith(401)
      expect(lines).toEqual([])
    } finally {
      await fiber.dispose()
    }
  })

  it('refuses the stream with 401 when a provider is present but no connection service is', async () => {
    const { fiber, route } = await mountEvents({ provider: allowAll, connection: false })
    try {
      const { lines, response } = await requestEvents(route, { host: 'localhost' })
      expect(response.writeHead).toHaveBeenCalledWith(401)
      expect(lines).toEqual([])
    } finally {
      await fiber.dispose()
    }
  })
})
