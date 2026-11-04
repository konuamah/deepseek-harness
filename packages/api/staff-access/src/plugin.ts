/**
 * Staff access plugin: opens the owner index, provides it as `staffSessions`, registers the staff Remote
 * access policy, and provides the staff `externalPeerAdmission` with its revocation sweep. Mounting it changes
 * access only for staff callers; the owner Host is unaffected.
 *
 * @module @deepseek-ai/dsh-api-staff-access/src/plugin
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remote-access'
import type {} from '@deepseek-ai/dsh-client-connection'
import { admitStaffCreates } from './create-admission.ts'
import { createDjangoStaffAuthenticator } from './django-authenticator.ts'
import { createStaffAdmission } from './external-admission.ts'
import { createSessionOwnerIndex, type SessionOwnerIndex } from './owner-index.ts'
import { createStaffPolicy } from './policy.ts'

export const name = 'staff-access'

/** Configuration of the staff access plugin. */
export interface Config {
  /** Owner-local JSON file recording which staff user owns each Session. */
  readonly ownersFile: string
  /** Django origin, such as `https://django.example`; http and https only, no path, query, or credentials. */
  readonly djangoBaseUrl: string
  /** Session cookie name the staff caller presents. Defaults to `sessionid`. */
  readonly cookieName?: string
  /** Django roles allowed to use the Host. Defaults to `ADMISSIONS_MANAGER` and `ADMISSIONS_OFFICER`. */
  readonly roles?: readonly string[]
  /** Lifetime in milliseconds of an allow decision. Defaults to 60 000. */
  readonly ttlMs?: number
  /** Interval in milliseconds between revocation sweeps. Defaults to 30 000. */
  readonly sweepIntervalMs?: number
}

/** The service this plugin provides under `staffSessions`. */
export interface StaffSessionsService {
  /** Owner index of the Sessions staff users own. */
  readonly owners: SessionOwnerIndex
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Staff ownership of Sessions, provided by the staff access plugin. */
    staffSessions: StaffSessionsService
  }
}

const DEFAULT_COOKIE_NAME = 'sessionid'
const DEFAULT_ROLES: readonly string[] = ['ADMISSIONS_MANAGER', 'ADMISSIONS_OFFICER']
const DEFAULT_TTL_MS = 60_000
const DEFAULT_SWEEP_INTERVAL_MS = 30_000
/** Largest delay `setInterval` accepts; a larger value fires at once. */
const MAX_TIMER_MS = 2_147_483_647

/** Config with every default applied and every value checked. */
interface Settings {
  readonly baseUrl: string
  readonly cookieName: string
  readonly roles: readonly string[]
  readonly ttlMs: number
  readonly sweepIntervalMs: number
}

/**
 * Mount the staff access plugin.
 * @param ctx - Host Context that receives the service, the policy, and the external admission provider.
 * @param config - Plugin configuration; `ownersFile` and `djangoBaseUrl` are required.
 * @throws Error when `ownersFile` is missing or empty, when a setting is invalid, or when the owner file does not load.
 */
export function apply(ctx: Context, config: Config): void {
  if (typeof config.ownersFile !== 'string' || config.ownersFile === '') {
    throw new Error('staff-access: ownersFile is required')
  }
  const settings = resolveSettings(config)
  const owners = createSessionOwnerIndex({ file: config.ownersFile })
  ctx.provide('staffSessions', { owners })
  const authenticator = createDjangoStaffAuthenticator({
    baseUrl: settings.baseUrl,
    cookieName: settings.cookieName,
    roles: settings.roles,
    ttlMs: settings.ttlMs,
  })
  ctx.inject(['remoteAccess'], (scope) => {
    scope.remoteAccess.registerPolicy('staff', createStaffPolicy({ owners }))
    admitStaffCreates(scope, { owners })
  })
  ctx.inject(['connection', 'agents', 'remoteAccess'], (scope) => {
    const admission = createStaffAdmission({ authenticator, cookieName: settings.cookieName, owners, scope })
    scope.provide('externalPeerAdmission', admission)
    scope.effect(() => {
      const timer = setInterval(() => { void admission.sweep() }, settings.sweepIntervalMs)
      timer.unref()
      return () => {
        clearInterval(timer)
        admission.dispose()
      }
    }, 'staff-access: revocation sweep')
  })
}

/**
 * Apply the defaults and validate every staff access setting.
 * @param config - plugin configuration as written.
 * @returns the settings the plugin runs with.
 * @throws Error naming the first invalid setting; the message never echoes a configured value.
 */
function resolveSettings(config: Config): Settings {
  const cookieName = config.cookieName ?? DEFAULT_COOKIE_NAME
  assertCookieName(cookieName)
  const roles = config.roles ?? DEFAULT_ROLES
  assertRoles(roles)
  const ttlMs = config.ttlMs ?? DEFAULT_TTL_MS
  assertDelay(ttlMs, 'ttlMs')
  const sweepIntervalMs = config.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS
  assertDelay(sweepIntervalMs, 'sweepIntervalMs')
  return { baseUrl: originOf(config.djangoBaseUrl), cookieName, roles, ttlMs, sweepIntervalMs }
}

/**
 * Check that the cookie name is a plain token, so it can be written into a Cookie header unchanged.
 * @param cookieName - configured cookie name.
 * @throws Error when the name is empty or contains a character outside letters, digits, `_`, `.`, and `-`.
 */
function assertCookieName(cookieName: string): void {
  if (!/^[A-Za-z0-9_.-]+$/.test(cookieName)) {
    throw new Error('staff-access: cookieName must use only letters, digits, "_", ".", or "-"')
  }
}

/**
 * Check that the roles form a non-empty list of non-empty role names.
 * @param roles - configured roles.
 * @throws Error when the list is empty or holds a value that is not a non-empty string.
 */
function assertRoles(roles: unknown): void {
  const valid = Array.isArray(roles) && roles.length > 0 && roles.every(role => typeof role === 'string' && role !== '')
  if (!valid) throw new Error('staff-access: roles must be a non-empty list of role names')
}

/**
 * Check that a setting is a positive delay `setInterval` can hold.
 * @param value - configured number of milliseconds.
 * @param field - setting name for the error message.
 * @throws Error when the value is not a positive integer no larger than the timer limit.
 */
function assertDelay(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_MS) {
    throw new Error(`staff-access: ${field} must be a positive whole number of milliseconds`)
  }
}

/**
 * Reduce the Django base URL to its origin, refusing anything that is not a bare http or https origin.
 * @param value - configured `djangoBaseUrl`.
 * @returns the origin, without a trailing slash.
 * @throws Error when the value is not a string, is not an http or https URL, or carries a path, query, fragment, or credentials.
 */
function originOf(value: unknown): string {
  const invalid = new Error('staff-access: djangoBaseUrl must be an http or https origin such as https://django.example')
  if (typeof value !== 'string') throw invalid
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw invalid
  }
  const bare = url.username === '' && url.password === '' && url.pathname === '/' && url.search === '' && url.hash === ''
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !bare) throw invalid
  return url.origin
}
