/**
 * REAL-composition coverage: a test-only cordis.yml booted through the
 * vendored Loader mounts the webserver and frontend-static rows, and every
 * assertion observes the served HTTP surface — asset serving, explicit index
 * entry points with index taps, 404 misses, traversal rejection, 405 on non-
 * GET/HEAD, and seat release on fiber disposal (HMR safety).
 */

import { request as httpRequest } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import * as FrontendStatic from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * Write a dist fixture and the authenticated Web rows, then boot them through the real Loader.
 * An external provider, when given, is provided on the root context before the rows boot.
 * A loginUrl, when given, is written into the frontend-static config.
 */
async function loadComposition(external?: Connection.ExternalPeerAdmission, loginUrl?: string): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-frontend-static-'))
  const dist = join(root, 'dist')
  await mkdir(dist)
  const distIndex = join(dist, 'index.html')
  await writeFile(distIndex, '<head></head><body>shell</body>')
  await writeFile(join(dist, 'app.js'), 'export {}')
  await writeFile(join(dist, 'preview.html'), '<body>preview</body>')
  await writeFile(join(dist, 'blob.bin'), 'BLOB')
  await writeFile(join(dist, 'manifest.webmanifest'), '{}')
  await writeFile(join(dist, 'icon-192.png'), 'PNG')
  await mkdir(join(dist, 'empty'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-credentials-local'",
    '  config:',
    `    path: '${join(root, '.credentials.yaml')}'`,
    '    watch: false',
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    "- name: '@deepseek-ai/dsh-client-connection'",
    '- id: frontend',
    "  name: '@deepseek-ai/dsh-host-frontend-static'",
    '  config:',
    `    distIndex: '${distIndex}'`,
    ...(loginUrl === undefined ? [] : [`    loginUrl: '${loginUrl}'`]),
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  if (external !== undefined) context.provide('externalPeerAdmission', external)
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-credentials-local', LocalCredentials],
    ['@deepseek-ai/dsh-host-webserver', HttpServer],
    ['@deepseek-ai/dsh-client-connection', Connection],
    ['@deepseek-ai/dsh-host-frontend-static', FrontendStatic],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

/** GET (by default) one path against the running server; returns status, content-type, and the body. */
async function request(
  port: number | undefined,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; type: string | null; body: string }> {
  if (port === undefined) throw new Error('frontend-static test: the listener has not bound a port')
  const response = await fetch(`http://127.0.0.1:${String(port)}${path}`, init)
  return {
    status: response.status,
    type: response.headers.get('content-type'),
    body: await response.text(),
  }
}

describe('real Loader composition', () => {
  it('serves explicit index entries and files while preserving HTTP error semantics', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition()
    const unloaded = [...loaded.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])
    const server = loaded.webServer
    const port = server.port
    const launchUrl = loaded.connection.authenticatedUrl(`http://127.0.0.1:${String(port)}`)
    const exchange = await fetch(launchUrl, { redirect: 'manual' })
    expect(exchange.status).toBe(303)
    expect(exchange.headers.get('location')).toBe('./')
    const setCookie = exchange.headers.get('set-cookie')
    if (setCookie === null) throw new Error('authenticated frontend did not set a cookie')
    const cookie = setCookie.split(';', 1)[0]!
    const authenticated = (init?: RequestInit): RequestInit => {
      const headers = new Headers(init?.headers)
      headers.set('cookie', cookie)
      return { ...init, headers }
    }

    expect(await request(port, '/')).toMatchObject({
      status: 401,
      type: 'text/plain; charset=utf-8',
      body: 'dsh web authentication required; reopen the URL printed by dsh web.\n',
    })
    // Without a provider the refusal is the owner's own 401: no redirect and no
    // cookie; its no-store header is Connection's, not the staff path's.
    const refused = await fetch(`http://127.0.0.1:${String(port)}/`)
    expect(refused.headers.get('cache-control')).toBe('no-store')
    expect(refused.headers.get('location')).toBeNull()
    expect(refused.headers.get('set-cookie')).toBeNull()

    // Real assets with their MIME types; a live rebuild is served on the next read.
    expect(await request(port, '/app.js')).toMatchObject({ status: 200, type: 'text/javascript; charset=utf-8', body: 'export {}' })
    expect(await request(port, '/manifest.webmanifest')).toMatchObject({
      status: 200,
      type: 'application/manifest+json',
      body: '{}',
    })
    // The install icons are images; a launcher must not receive them as octet-stream.
    expect(await request(port, '/icon-192.png')).toMatchObject({ status: 200, type: 'image/png', body: 'PNG' })
    expect(await request(port, '/app.js', { method: 'HEAD' })).toEqual({
      status: 200,
      type: 'text/javascript; charset=utf-8',
      body: '',
    })
    await writeFile(join(root!, 'dist', 'app.js'), 'export const rebuilt = true')
    expect(await request(port, '/app.js')).toMatchObject({ status: 200, body: 'export const rebuilt = true' })

    // Unknown extension ships as octet-stream.
    expect(await request(port, '/blob.bin')).toMatchObject({ status: 200, type: 'application/octet-stream', body: 'BLOB' })

    // Only the root and index path render index.html through registered taps.
    const untap = server.tapIndex(html => html.replace('<head>', '<head><script>window.__T__=1</script>'))
    // A plugin row stands in for the Host's plugin-resource rows: the base the
    // shell inserts must precede it, not merely exist.
    const renderedFor: Connection.PeerScope[] = []
    const offRows = loaded.on('webserver/index-inject', (rows, peer) => {
      renderedFor.push(peer)
      rows.push({ kind: 'script-preload', src: 'plugins/boot.js' })
    })
    for (const path of ['/', '/index.html', '/?view=test']) {
      const got = await request(port, path, authenticated())
      expect(got.status).toBe(200)
      expect(got.type).toBe('text/html; charset=utf-8')
      expect(got.body).toContain('__T__')
      expect(got.body).toContain('shell')
      // The served document carries the entry-directory base exactly once, and
      // it precedes every injected row and tap markup, so the shell's
      // app-owned routes and the Host's resource rows resolve under one mount.
      expect(got.body.match(/<base\b/g)).toHaveLength(1)
      const base = got.body.indexOf('<base href="./">')
      expect(base).toBeLessThan(got.body.indexOf('<link rel="preload" as="script" href="plugins/boot.js">'))
      expect(base).toBeLessThan(got.body.indexOf('<script>window.__T__=1</script>'))
    }
    // An authenticated browser renders for the owner's shared browser Peer.
    expect(renderedFor).toEqual([loaded.connection.browserPeer, loaded.connection.browserPeer, loaded.connection.browserPeer])
    offRows()
    expect(await request(port, '/', authenticated({ method: 'HEAD' }))).toEqual({
      status: 200,
      type: 'text/html; charset=utf-8',
      body: '',
    })
    untap()
    expect((await request(port, '/', authenticated())).body).not.toContain('__T__')

    // A missing configured index follows the same empty-404 contract for both
    // of its public entry paths and for both supported methods.
    await rm(join(root!, 'dist', 'index.html'))
    for (const path of ['/', '/index.html']) {
      const get = await request(port, path, authenticated())
      const head = await request(port, path, authenticated({ method: 'HEAD' }))
      expect(get).toEqual({ status: 404, type: null, body: '' })
      expect(head).toEqual(get)
    }

    // Ordinary unknown paths and static-resource misses are empty 404s for
    // both GET and HEAD; neither class can be mistaken for the HTML shell.
    const ordinaryMisses = ['/no/such/route', '/empty', '/app.js/child']
    const assetMisses = [
      '/missing.js',
      '/missing.css',
      '/missing.mjs',
      '/missing.js.map',
      '/missing.webmanifest',
      '/missing.manifest',
    ]
    for (const path of [...ordinaryMisses, ...assetMisses]) {
      const get = await request(port, path)
      const head = await request(port, path, { method: 'HEAD' })
      expect(get).toEqual({ status: 404, type: null, body: '' })
      expect(head).toEqual(get)
    }
    expect(await request(port, '/api/no/such/route', authenticated())).toEqual({
      status: 404,
      type: 'text/plain;charset=UTF-8',
      body: 'not found',
    })

    // Traversal outside the dist root is 403, non-GET/HEAD is 405, and a
    // malformed filesystem target still reaches the webserver's 400 guard.
    expect((await request(port, '/..%2f..%2fetc%2fpasswd')).status).toBe(403)
    expect((await request(port, '/app.js', { method: 'POST' })).status).toBe(405)
    expect((await request(port, '/bad%00path')).status).toBe(400)

    // HMR safety: disposing the frontend row releases the fallback seat (the
    // unclaimed webserver answers 404) and the seat is claimable again.
    const frontendEntry = [...loaded.loader.entries()].find(e => e.options.id === 'frontend')
    expect(frontendEntry).toBeDefined()
    await frontendEntry!.fiber?.dispose()
    expect((await request(port, '/no/such/route')).status).toBe(404)
    expect(() => server.registerFallback(() => {})).not.toThrow()
  })

  it('answers in-process reads for the given Peer without browser authentication', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition()
    const server = loaded.webServer
    const reader = { principal: { kind: 'owner' } } as Connection.PeerScope
    const read = (path: string, init?: RequestInit) => server.readResource(new Request(`http://reader.invalid${path}`, init), reader)
    const renderedFor: Connection.PeerScope[] = []
    loaded.on('webserver/index-inject', (rows, peer) => {
      renderedFor.push(peer)
      rows.push({ kind: 'global', name: '__READER__', value: peer === reader })
    })

    // The index renders for the reader's Peer with no cookie or token, and
    // keeps the entry-directory base ahead of the injected rows.
    for (const path of ['/', '/index.html']) {
      const index = await read(path)
      expect(index.status).toBe(200)
      expect(index.headers.get('content-type')).toBe('text/html; charset=utf-8')
      const html = await index.text()
      expect(html).toContain('globalThis["__READER__"] = true')
      expect(html.indexOf('<base href="./">')).toBeLessThan(html.indexOf('__READER__'))
      expect(html).toContain('shell')
    }
    expect(renderedFor).toEqual([reader, reader])
    const head = await read('/', { method: 'HEAD' })
    expect({ status: head.status, type: head.headers.get('content-type'), body: await head.text() })
      .toEqual({ status: 200, type: 'text/html; charset=utf-8', body: '' })

    // Assets, misses, traversal, and methods keep the HTTP semantics.
    const asset = await read('/app.js')
    expect({ status: asset.status, type: asset.headers.get('content-type'), body: await asset.text() })
      .toEqual({ status: 200, type: 'text/javascript; charset=utf-8', body: 'export {}' })
    expect((await read('/missing.js')).status).toBe(404)
    expect((await read('/..%2f..%2fetc%2fpasswd')).status).toBe(403)
    expect((await read('/app.js', { method: 'POST', body: 'x' })).status).toBe(405)
    await expect(read('/bad%00path')).rejects.toThrow()
    await rm(join(root!, 'dist', 'index.html'))
    expect((await read('/')).status).toBe(404)
  })

  it('lets browsers revalidate every file except the index', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition()
    const base = `http://127.0.0.1:${String(loaded.webServer.port)}`
    const first = await fetch(`${base}/app.js`)
    const etag = first.headers.get('etag')
    if (etag === null) throw new Error('a dist file carried no ETag')
    expect(etag).toMatch(/^W\/"[A-Za-z0-9_-]+"$/)
    expect(first.headers.get('cache-control')).toBe('no-cache')
    expect(await first.text()).toBe('export {}')

    const revalidated = await fetch(`${base}/app.js`, { headers: { 'if-none-match': etag } })
    expect([revalidated.status, revalidated.headers.get('etag'), revalidated.headers.get('cache-control')]).toEqual([304, etag, 'no-cache'])
    expect(await revalidated.text()).toBe('')
    // An in-process read revalidates the same way.
    const reader = { principal: { kind: 'owner' } } as Connection.PeerScope
    const read = await loaded.webServer.readResource(new Request(`${base}/app.js`, { headers: { 'if-none-match': etag } }), reader)
    expect(read.status).toBe(304)

    // New content under the same name changes the ETag, so the stale copy is replaced.
    await writeFile(join(root!, 'dist', 'app.js'), 'export const rebuilt = true')
    const rebuilt = await fetch(`${base}/app.js`, { headers: { 'if-none-match': etag } })
    expect(rebuilt.status).toBe(200)
    expect(rebuilt.headers.get('etag')).not.toBe(etag)
    expect(await rebuilt.text()).toBe('export const rebuilt = true')

    // Only the rendered index carries no cache headers; another HTML file revalidates.
    const html = await fetch(`${base}/preview.html`)
    expect([html.status, html.headers.get('cache-control')]).toEqual([200, 'no-cache'])
    expect(html.headers.get('etag')).toMatch(/^W\//)
    expect(await html.text()).toBe('<body>preview</body>')
    const index = await loaded.webServer.readResource(new Request(`${base}/`), reader)
    expect([index.status, index.headers.get('cache-control'), index.headers.get('etag')]).toEqual([200, null, null])
  })
})

/** GET one path with an exact Host header, which Fetch does not let a test set. */
function getWithHost(port: number | undefined, path: string, host: string): Promise<{ status: number; body: string }> {
  if (port === undefined) throw new Error('frontend-static test: the listener has not bound a port')
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, headers: { host } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

describe('external Peer index admission', () => {
  const STAFF: Connection.Principal = { kind: 'staff', userId: 42, role: 'teacher' }
  /** Path and query with characters that must survive the `next` round trip. */
  const next = '/?x=a%20b&y=%C3%A9/&z=1'
  let answer: () => Promise<Connection.ExternalAdmission>
  let attempts = 0
  const provider: Connection.ExternalPeerAdmission = {
    admit() {
      attempts += 1
      return answer()
    },
  }

  it('admits a staff Peer for the index, keeps the owner cookie first, and leaves assets public', { timeout: 60_000 }, async () => {
    answer = async () => ({ kind: 'allow', key: 'staff:42', principal: STAFF })
    attempts = 0
    const loaded = await loadComposition(provider)
    const base = `http://127.0.0.1:${String(loaded.webServer.port)}`
    loaded.on('webserver/index-inject', (rows, peer) => {
      rows.push({ kind: 'global', name: 'who', value: peer.principal })
    })

    // The launch token still exchanges for the owner cookie; the provider is not consulted.
    const exchange = await fetch(loaded.connection.authenticatedUrl(base), { redirect: 'manual' })
    expect(exchange.status).toBe(303)
    const cookie = (exchange.headers.get('set-cookie') ?? '').split(';', 1)[0]!
    expect(attempts).toBe(0)

    const owner = await fetch(`${base}/`, { headers: { cookie } })
    expect(owner.status).toBe(200)
    expect(owner.headers.get('cache-control')).toBeNull()
    expect(await owner.text()).toContain('owner')
    expect(attempts).toBe(0)

    // An anonymous index request is admitted as the staff Peer, rendered uncached.
    const staff = await fetch(`${base}/`)
    expect(staff.status).toBe(200)
    expect(staff.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(staff.headers.get('cache-control')).toBe('no-store')
    expect(staff.headers.get('set-cookie')).toBeNull()
    const html = await staff.text()
    expect(html).toContain('teacher')
    expect(html).not.toContain('owner')
    expect(html.match(/<base\b/g)).toHaveLength(1)
    expect(attempts).toBe(1)

    // Static assets stay public and never reach the provider.
    expect((await fetch(`${base}/app.js`)).status).toBe(200)
    expect(attempts).toBe(1)
  })

  it('redirects a refused or failing index request to loginUrl with the path and query in next', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition(provider)
    const base = `http://127.0.0.1:${String(loaded.webServer.port)}`
    const headers = {
      referer: 'https://evil.example/',
      'x-forwarded-host': 'evil.example',
      'x-forwarded-proto': 'https',
      'x-forwarded-prefix': '//evil.example',
    }
    const throws = async (): Promise<Connection.ExternalAdmission> => {
      throw new Error('provider down')
    }

    for (const decide of [async () => ({ kind: 'deny' as const }), throws]) {
      answer = decide
      const before = attempts
      const denied = await fetch(`${base}${next}`, { redirect: 'manual', headers })
      expect(attempts).toBe(before + 1)
      expect(denied.status).toBe(302)
      const location = denied.headers.get('location') ?? ''
      expect(location).toBe(`/login?next=${encodeURIComponent(next)}`)
      expect(decodeURIComponent(location.slice('/login?next='.length))).toBe(next)
      expect(location).not.toContain('evil')
      expect(denied.headers.get('cache-control')).toBe('no-store')
      expect(denied.headers.get('set-cookie')).toBeNull()
    }
  })

  it('answers the owner 401 without asking the provider for a request that fails the Host fence', { timeout: 60_000 }, async () => {
    answer = async () => ({ kind: 'allow', key: 'staff:42', principal: STAFF })
    attempts = 0
    const loaded = await loadComposition(provider)
    const response = await getWithHost(loaded.webServer.port, '/', 'evil.example')
    expect(response).toEqual({
      status: 401,
      body: 'dsh web authentication required; reopen the URL printed by dsh web.\n',
    })
    expect(attempts).toBe(0)
  })

  it('renders the login URL meta element only when an external Peer provider is composed', { timeout: 60_000 }, async () => {
    const page = '<head></head><body></body>'
    const withProvider = await loadComposition(provider)
    const rendered = withProvider.webServer.renderIndex(page, withProvider.connection.browserPeer)
    expect(rendered).toContain('<meta name="dsh-staff-login-url" content="/login">')
    await withProvider.fiber.dispose()
    context = undefined

    const ownerOnly = await loadComposition()
    expect(ownerOnly.webServer.renderIndex(page, ownerOnly.connection.browserPeer)).not.toContain('dsh-staff-login-url')
  })

  it('renders a configured loginUrl as the login URL meta content', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition(provider, '/signin')
    const rendered = loaded.webServer.renderIndex('<head></head><body></body>', loaded.connection.browserPeer)
    expect(rendered).toContain('<meta name="dsh-staff-login-url" content="/signin">')
    expect(rendered).not.toContain('content="/login"')
  })

  it('rejects a loginUrl that is not a same-origin absolute path', () => {
    expect(FrontendStatic.Config({ distIndex: '/dist/index.html' }).loginUrl).toBe('/login')
    expect(FrontendStatic.Config({ distIndex: '/dist/index.html', loginUrl: '/sign-in' }).loginUrl).toBe('/sign-in')
    for (const loginUrl of ['//evil.example', '/\\evil.example', 'https://x', 'login']) {
      expect(() => FrontendStatic.Config({ distIndex: '/dist/index.html', loginUrl })).toThrow()
    }
  })
})
