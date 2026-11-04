/** Staff login redirect: at most one login navigation per page load when the session is lost. */
import { API_PATH } from '../api-path.ts'
import type { ConnectionWebSocket } from './socket.ts'

/** Name of the meta element the Host renders when staff mode is on. */
export const STAFF_LOGIN_META_NAME = 'dsh-staff-login-url'

/** The document reads needed to find the injected meta element. */
export interface StaffLoginDocument {
  querySelector(selector: string): { getAttribute(name: string): string | null } | null
}

/** Page location fields the redirect reads and navigates. */
export interface StaffLoginLocation {
  readonly pathname: string
  readonly search: string
  assign(url: string): void
}

/** Inputs of {@link createStaffLogin}. */
export interface StaffLoginOptions {
  /** Validated same-origin login path, from {@link readStaffLoginUrl}. */
  readonly loginUrl: string
  readonly location: StaffLoginLocation
  /** Resolves the HTTP status of one authenticated probe; a rejection counts as no answer. */
  readonly probe: () => Promise<number>
}

/** Redirect hooks for the two failure paths. */
export interface StaffLogin {
  /** Call when a unary /api request answered HTTP 401. */
  readonly unauthorized: () => void
  /** Watch a socket: on its `error` or `close` event, probe, and redirect only when the probe answers 401. */
  readonly watchSocket: (socket: ConnectionWebSocket) => void
}

const LOGIN_URL_PATTERN = /^\/(?![/\\])/

/**
 * Read the login URL the Host injected.
 * @param doc - the page document, or undefined outside a document. A document may lack `querySelector`.
 * @returns the validated login path. An undefined document or one without `querySelector` returns undefined silently.
 * An absent meta element returns undefined silently, and so does a meta element without a `content` attribute.
 * A present value that is not a single-slash path (including the empty string) logs one console error and returns undefined.
 */
export function readStaffLoginUrl(doc: Partial<StaffLoginDocument> | undefined): string | undefined {
  if (typeof doc?.querySelector !== 'function') return undefined
  const element = doc.querySelector(`meta[name="${STAFF_LOGIN_META_NAME}"]`)
  if (element === null) return undefined
  const value = element.getAttribute('content')
  if (value === null) return undefined
  if (LOGIN_URL_PATTERN.test(value)) return value
  console.error(`[connection] invalid ${STAFF_LOGIN_META_NAME} ${JSON.stringify(value)}; staff login redirect disabled`)
  return undefined
}

/**
 * Create the redirect hooks for one page load.
 * @param options - validated login path, page location, and the probe.
 * @returns hooks that navigate at most once per page load, never from the login path itself.
 */
export function createStaffLogin(options: StaffLoginOptions): StaffLogin {
  const { loginUrl, location, probe } = options
  let redirected = false
  const redirect = (): void => {
    if (redirected || location.pathname.startsWith(loginUrl)) return
    redirected = true
    location.assign(`${loginUrl}?next=${encodeURIComponent(location.pathname + location.search)}`)
  }
  const probeThenRedirect = (): void => {
    probe().then((status) => { if (status === 401) redirect() }, () => {})
  }
  return {
    unauthorized: redirect,
    watchSocket(socket) {
      socket.addEventListener('error', probeThenRedirect, { once: true })
      socket.addEventListener('close', probeThenRedirect, { once: true })
    },
  }
}

/** Probe request: the /api prefix is admitted before routing, so 401 means no session. Any other status means a session. */
export const STAFF_PROBE_PATH = `${API_PATH.slice(1)}/`
