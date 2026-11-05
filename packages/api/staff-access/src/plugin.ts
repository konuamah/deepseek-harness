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
import { prepareStaffWorkspaceDir, resolveStaffWorkspaceDir } from './staff-workspace.ts'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'

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
  /**
   * Write each Remote call or event the staff policy refuses to stderr, once per method, user, and refused resource
   * per process, as `<timestamp> staff-access: denied <method> for user <id>`, followed by ` on <kind>:<id>` when the
   * refusal names a resource. Defaults to false.
   */
  readonly logDenied?: boolean
  /**
   * Absolute directory of the one Workspace staff callers use. Created empty at mount when missing; an existing
   * directory is accepted only when it is empty or was prepared by this plugin. Defaults to
   * `staff-workspace` under the Harness home.
   */
  readonly workspaceDir?: string
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
/** Most distinct denied (method, user, resource) triples remembered; the oldest is forgotten first. */
const LOGGED_DENIAL_LIMIT = 2000
/** Named logger whose denial lines `logDenied` writes to stderr. */
const DENIAL_LOGGER = 'staff-access'

/** Config with every default applied and every value checked. */
interface Settings {
  readonly baseUrl: string
  readonly cookieName: string
  readonly roles: readonly string[]
  readonly ttlMs: number
  readonly sweepIntervalMs: number
  readonly logDenied: boolean
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
  const workspaceDir = resolveStaffWorkspaceDir(config.workspaceDir)
  prepareStaffWorkspaceDir(workspaceDir)
  const owners = createSessionOwnerIndex({ file: config.ownersFile })
  ctx.provide('staffSessions', { owners })
  // Set once the registry holds the shared Workspace; until then no staff binding or create is admitted.
  let sharedWorkspace: WorkspaceId | undefined
  const workspaceId = (): WorkspaceId | undefined => sharedWorkspace
  ctx.inject(['workspaceRegistry'], (scope) => {
    scope.effect(() => () => { sharedWorkspace = undefined }, 'staff-access: shared workspace')
    scope.workspaceRegistry.create(workspaceDir).then(
      (workspace) => { sharedWorkspace = workspace.id },
      (error: unknown) => {
        ctx.logger.error(`staff-access: could not register the staff Workspace: ${error instanceof Error ? error.message : String(error)}`)
      },
    )
  })
  const authenticator = createDjangoStaffAuthenticator({
    baseUrl: settings.baseUrl,
    cookieName: settings.cookieName,
    roles: settings.roles,
    ttlMs: settings.ttlMs,
  })
  ctx.inject(['remoteAccess'], (scope) => {
    scope.remoteAccess.registerPolicy('staff', createStaffPolicy({ owners, workspaceId }))
    admitStaffCreates(scope, { owners, workspaceId })
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
  if (settings.logDenied) logDeniedCalls(ctx)
}

/**
 * Write each Remote call or event the staff policy refuses for a staff caller to stderr, once per method, user, and resource.
 * The Host registers no console exporter, so this plugin's own exporter prints its named logger's lines only.
 * The line carries the endpoint and the numeric user id only; owner and other principal kinds are ignored.
 * @param ctx - Host Context whose `remote-access/denied` events are observed; the exporter ends with its fiber.
 */
function logDeniedCalls(ctx: Context): void {
  const logger = ctx.logger(DENIAL_LOGGER)
  ctx.logger.exporter({
    // 2 is the Cordis INFO level; the name check below keeps other loggers out of stderr.
    levels: { [DENIAL_LOGGER]: 2 },
    export: (message) => {
      if (message.name !== DENIAL_LOGGER) return
      process.stderr.write(`${new Date(message.ts).toISOString()} ${String(message.args[0])}\n`)
    },
  })
  const logged = new Set<string>()
  ctx.on('remote-access/denied', (principal, action, resource) => {
    if (principal.kind !== 'staff') return
    const target = resource === undefined ? ''
      : resource.kind === 'global' ? ' on global' : ` on ${resource.kind}:${String(resource.id)}`
    const key = `${action}\n${principal.userId}\n${target}`
    if (logged.has(key)) return
    if (logged.size >= LOGGED_DENIAL_LIMIT) {
      const oldest = logged.values().next().value
      if (oldest !== undefined) logged.delete(oldest)
    }
    logged.add(key)
    logger.info(`staff-access: denied ${action} for user ${principal.userId}${target}`)
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
  const logDenied = resolveLogDenied(config.logDenied)
  return { baseUrl: originOf(config.djangoBaseUrl), cookieName, roles, ttlMs, sweepIntervalMs, logDenied }
}

/**
 * Default and check the denial logging switch.
 * @param value - configured `logDenied`, or undefined when unset.
 * @returns the switch, false when unset.
 * @throws Error when the value is not a boolean.
 */
function resolveLogDenied(value: boolean | undefined): boolean {
  const logDenied = value ?? false
  if (typeof logDenied !== 'boolean') throw new Error('staff-access: logDenied must be true or false')
  return logDenied
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
