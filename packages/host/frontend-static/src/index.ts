/**
 * @deepseek-ai/dsh-host-frontend-static — SPA dist server over the webserver
 * fallback seat: a webserver resource serving the built frontend directory
 * with explicit index entry points. A readable index renders at the dist root
 * and configured index path; missing paths return 404, traversal outside the
 * dist root is 403, unknown extensions ship as octet-stream, and non-GET/HEAD
 * is 405. An HTTP index request first passes Connection's browser
 * authentication and renders for the browser Peer; an in-process read renders
 * for the Peer its caller admitted. When an external Peer provider is composed
 * and browser authentication refuses an HTTP index request, the provider may
 * admit a staff Peer (rendered with `cache-control: no-store`); a refusal
 * redirects to `loginUrl` with the requested path and query in `next`. A
 * staff-Peer-capable index carries the `dsh-staff-login-url` meta element with
 * the login URL.
 * Both renders go through the webserver's
 * index render (structured injection rows, then raw taps). Non-index assets
 * stay public; every file other than the index carries a weak ETag with
 * `cache-control: no-cache` and answers a matching `If-None-Match` with 304,
 * while the index carries no cache headers. The dist location is workspace
 * knowledge of the composing application, so `distIndex` is typically
 * supplied through a `!!js` expression, never hardcoded by a deployment.
 * @module @deepseek-ai/dsh-host-frontend-static
 */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { PeerScope } from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Stable Cordis plugin name. */
export const name = 'frontend-static'

/** Services required before the authenticated fallback seat can be claimed. */
export const inject = ['webServer', 'connection']

/** Plugin config: the dist anchor. */
export interface Config {
  /** Absolute path of index.html inside the dist root. */
  distIndex: string
  /**
   * Same-origin path a refused index request redirects to, with the requested
   * path and query in `next`. Used only when an external Peer provider is composed.
   * @default '/login'
   */
  loginUrl?: string
}

export const Config: z<Config> = z.object({
  distIndex: z.string().required(),
  loginUrl: z.string().pattern(/^\/(?![/\\])/).default('/login'),
})

/** Who may read the index, or the response that refuses it. */
type IndexAccess =
  | { readonly response: Response }
  | { readonly peer?: PeerScope | undefined; readonly staff?: boolean }

const HTML_MIME = 'text/html; charset=utf-8'

const MIME: Record<string, string> = {
  '.html': HTML_MIME,
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  // Launchers require an image Content-Type for the install icons.
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
  // The packed VFS image. Served as its own bytes, never as a Content-Encoding:
  // the worker inflates the body itself, and a transport-level encoding would
  // leave it inflating an already-decoded archive.
  '.gz': 'application/gzip',
}

const STATIC_MISS_CODES: ReadonlySet<string | undefined> = new Set([
  'ENOENT',
  'EISDIR',
  'ENOTDIR',
])

/** A Response body that is `bytes` itself, without the copy a buffer body gets. */
function bytesBody(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

/**
 * Answer one GET or HEAD dist request; the webserver answers any other method
 * with 405 before a resource runs. A malformed percent-escape or a filesystem
 * failure other than a missing or non-file target rejects.
 * @param request - the request; only its method and URL path are read.
 * @param distRoot - absolute dist root directory (resolved by the caller).
 * @param distIndex - absolute path of index.html inside distRoot.
 * @param authorizeIndex - answers an index request before its bytes are read:
 * the refusal to send instead of the index, or the Peer to render it for.
 * @param renderIndex - turns the raw index.html body into the served document
 * for the Peer given (undefined means the browser Peer) and the dist root and
 * configured index path.
 * @returns the dist response; a HEAD response carries the GET status and
 * headers without a body. A file other than the index carries
 * `cache-control: no-cache` and a weak ETag from a SHA-1 of its bytes, and a
 * request whose `If-None-Match` equals that ETag receives an empty 304.
 */
async function serveStatic(
  request: Request, distRoot: string, distIndex: string,
  authorizeIndex: () => Promise<IndexAccess>,
  renderIndex: (html: string, peer: PeerScope | undefined) => string,
): Promise<Response> {
  const target = resolve(normalize(join(distRoot, decodeURIComponent(new URL(request.url).pathname))))
  // Traversal rejection: the target must be distRoot itself (`/`) or stay under
  // it. `sep`, not '/': resolve() emits backslash paths on Windows, where a '/'
  // suffix would reject every legitimate subpath as traversal.
  if (target !== distRoot && !target.startsWith(distRoot + sep)) return new Response(null, { status: 403 })
  let body: string | Uint8Array<ArrayBuffer>
  let headers: Record<string, string>
  try {
    if (target === distRoot || target === distIndex) {
      const access = await authorizeIndex()
      if ('response' in access) return access.response
      body = renderIndex(await readFile(distIndex, 'utf8'), access.peer)
      // A staff Peer's page is per-user, so no cache may hold it.
      headers = { 'content-type': HTML_MIME, ...(access.staff === true ? { 'cache-control': 'no-store' } : {}) }
    } else {
      body = await readFile(target)
      // Weak: gzip changes the transferred bytes.
      const cache = { 'cache-control': 'no-cache', etag: `W/"${createHash('sha1').update(body).digest('base64url')}"` }
      if (request.headers.get('if-none-match') === cache.etag) return new Response(null, { status: 304, headers: cache })
      headers = { 'content-type': MIME[extname(target)] ?? 'application/octet-stream', ...cache }
    }
  } catch (error) {
    // Only absent or non-file targets are 404; other filesystem failures reach
    // the caller, which the webserver answers with 400 over HTTP.
    if (!STATIC_MISS_CODES.has((error as NodeJS.ErrnoException).code)) throw error
    return new Response(null, { status: 404 })
  }
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
  return new Response(typeof body === 'string' ? body : bytesBody(body), { status: 200, headers })
}

/**
 * Escape a value for a double-quoted HTML attribute.
 * @param value - the raw attribute value.
 * @returns the value with `&`, `"`, `<` and `>` replaced by character references.
 */
function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Claim the webserver fallback seat with a resource serving the dist.
 * @param ctx - plugin context carrying the webServer and connection services.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const distIndex = config.distIndex
  const distRoot = dirname(distIndex)
  // schemastery's .default() guarantees the field is set after validation.
  const loginUrl = config.loginUrl as string
  // The login URL is emitted for staff-Peer renders only, so the client can
  // redirect a lost staff session; owner renders and owner-only deployments
  // keep the index unchanged.
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.on('webserver/index-inject', (table, peer) => {
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- other packages merge non-owner kinds into PrincipalMap.
      if (ctx.get('externalPeerAdmission') === undefined || peer.principal.kind === 'owner') return
      table.push({
        kind: 'html',
        placement: 'head',
        html: `<meta name="dsh-staff-login-url" content="${escapeAttribute(loginUrl)}">`,
      })
    })
  })
  // Connection's browser authentication writes the token exchange's 303 or
  // the 401 through a writeHead/end response; capture it as a Fetch response.
  // The answer stays a 401 unless Connection writes another one.
  const ownerIndex = (request: Request): IndexAccess => {
    let status = 401
    let headers = new Headers()
    let body: string | undefined
    const admitted = ctx.connection.authorizeIndex(request, {
      writeHead(nextStatus, nextHeaders) {
        status = nextStatus
        headers = new Headers(nextHeaders)
      },
      end(text) { body = text },
    })
    return admitted ? { peer: undefined } : { response: new Response(body, { status, headers }) }
  }
  // The owner path decides first. Only its own 401 goes on to the external
  // provider, and only a request that passed the Host/Origin fence reaches it.
  const authorizeIndex = async (request: Request): Promise<IndexAccess> => {
    const owner = ownerIndex(request)
    if (!('response' in owner) || owner.response.status !== 401 || ctx.get('externalPeerAdmission') === undefined) return owner
    const admission = await ctx.connection.admitAsync(request, { navigation: true })
    if ('peer' in admission) return { peer: admission.peer, staff: true }
    if (admission.rejection === 403) return owner
    const url = new URL(request.url)
    const next = url.pathname + url.search
    return {
      response: new Response(null, {
        status: 302,
        headers: { location: `${loginUrl}?next=${encodeURIComponent(next)}`, 'cache-control': 'no-store' },
      }),
    }
  }
  ctx.effect(() => ctx.webServer.registerFallback({
    resource: (request, peer) => serveStatic(
      request,
      distRoot,
      distIndex,
      // A read with a Peer was admitted by its caller; an HTTP request carries
      // none and passes Connection's browser authentication instead.
      () => peer === undefined ? authorizeIndex(request) : Promise.resolve({ peer }),
      // The browser authentication admits the owner's shared browser Peer. The
      // base goes in after all index transforms, so it precedes every resource
      // reference they insert.
      (html, rendered) => ctx.webServer.renderIndex(html, rendered ?? ctx.connection.browserPeer)
        .replace(/<head(?:\s[^>]*)?>/i, open => `${open}<base href="./">`),
    ),
  }), 'frontend-static: fallback seat')
}
