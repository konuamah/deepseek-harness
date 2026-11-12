/**
 * Staff composition wiring: the Remote policy, create admission, per-user AI
 * tokens, and the revocation sweep over one ownership authority.
 * @module @deepseek-ai/dsh-api-staff-access/src/composition
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remote-access'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { McpHeaders } from '@deepseek-ai/dsh-mcp-client'
import type {} from '@deepseek-ai/dsh-session-persistence-postgres'
import type { PostgresOwnershipService } from '@deepseek-ai/dsh-session-persistence-postgres'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-workspace'
import { createAiTokenProvider } from './ai-token.ts'
import { admitStaffCreates, type StaffCreateOwnership } from './create-admission.ts'
import { createDjangoStaffAuthenticator } from './django-authenticator.ts'
import { createStaffAdmission } from './external-admission.ts'
import type { SessionOwnerIndex, StaffOwnershipReader } from './owner-index.ts'
import { createStaffPolicy } from './policy.ts'

/** Resolved staff settings the composition consumes. */
export interface StaffSettings {
  readonly baseUrl: string
  readonly cookieName: string
  readonly roles: readonly string[]
  readonly ttlMs: number
  readonly sweepIntervalMs: number
  readonly toolServerName: string
}

/** One ownership authority plus the create path and readiness it supplies. */
interface StaffComposition {
  readonly ownership: StaffOwnershipReader
  readonly create: StaffCreateOwnership
  readonly available: () => boolean
  /** Observe a permanent authority failure; the listener revokes every staff user. */
  readonly onUnavailable?: (listener: () => void) => () => void
}

/** Present the database ownership view as the owner index other staff consumers expect. */
export function postgresOwnerIndex(view: PostgresOwnershipService): SessionOwnerIndex {
  const unsupported = (): never => {
    throw new Error('staff-access: Postgres Session ownership is written when the Session is created')
  }
  return {
    ownerOf: sessionId => view.ownerOf(sessionId),
    sessionsOf: userId => view.sessionsOf(userId),
    record: unsupported,
    forget: unsupported,
  }
}

/** Wire the policy, create admission, token minting, and sweep over one composition. */
export function installStaffComposition(
  ctx: Context,
  settings: StaffSettings,
  workspaceDir: string,
  composition: StaffComposition,
): void {
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
    scope.remoteAccess.registerPolicy('staff', createStaffPolicy({
      ownership: composition.ownership,
      workspaceId,
      available: composition.available,
    }))
    admitStaffCreates(scope, { ownership: composition.ownership, create: composition.create, workspaceId })
  })
  ctx.inject(['connection', 'agents', 'remoteAccess'], (scope) => {
    const tokens = createAiTokenProvider({
      djangoBaseUrl: settings.baseUrl,
      cookieName: settings.cookieName,
      cookieFor: userId => admission.cookieFor(userId),
      ownerOf: sessionId => composition.ownership.ownerOf(SessionId(sessionId)),
    })
    const admission = createStaffAdmission({
      authenticator,
      cookieName: settings.cookieName,
      owners: composition.ownership,
      scope,
      available: composition.available,
      onRevoke: (userId) => { tokens.drop(userId) },
    })
    scope.provide('externalPeerAdmission', admission)
    const mcpHeaders: McpHeaders = {
      async headersFor(serverName, exec) {
        if (serverName !== settings.toolServerName) return {}
        // A tool call is the last gate before work reaches the MCP service.
        if (!composition.available()) throw new Error('staff-access: chat storage is unavailable; restart the Harness')
        // A call with no Agent has no owner to mint for.
        if (exec.agent === undefined) throw new Error('staff-access: sign in again')
        return { Authorization: `Bearer ${await tokens.tokenFor(exec.agent.id)}` }
      },
    }
    scope.provide('mcpHeaders', mcpHeaders)
    const stopUnavailable = composition.onUnavailable?.(() => {
      admission.revokeAll('chat storage is unavailable')
    })
    scope.effect(() => {
      const timer = setInterval(() => { void admission.sweep() }, settings.sweepIntervalMs)
      timer.unref()
      return () => {
        clearInterval(timer)
        stopUnavailable?.()
        admission.dispose()
      }
    }, 'staff-access: revocation sweep')
  })
}
