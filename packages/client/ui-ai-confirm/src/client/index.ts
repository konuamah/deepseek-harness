/**
 * AI confirm card, browser half. The CInHEd tool service prepares approve, reject and request-documents
 * batches and changes nothing; this plugin registers a card for each of those three prepare tools in
 * ui-tool's keyed `tool.call.toolview` slot. The card shows the batch with names, lets the staff
 * member edit the reason, and on Confirm mints a short-lived write token with the staff session, uses
 * the batch up and writes each record.
 *
 * Both network faces are paths on the page's own origin (a reverse proxy forwards them), so the staff
 * session cookie travels with every call and no credential passes through the harness or the model.
 * Interaction state lives in a declared Session store so a card that remounts mid-confirm still shows
 * its progress. The card derives only from the logged call and result, and the outcome of a confirm is
 * read back from Django, never written to the session log.
 */
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createConfirmApi } from './api.ts'
import { createConfirmStore } from './confirm-store.ts'
import { ConfirmCard } from './ConfirmCard.tsx'
import { en, NS, zh, type AiConfirmKey } from './locales.ts'
import { ACTIONS, wireName } from './model.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The AI confirm card's copy. */
    aiConfirm: AiConfirmKey
  }
}

/** Deployment settings of the confirm card. */
export interface Config {
  /** `serverName` of the MCP entry that connects the tool service; the tool wire names derive from it. */
  serverName: string
  /** Page path the proxy forwards to the tool service's pending-batch routes. */
  toolsPath: string
  /** Page path the proxy forwards to Django's API. */
  apiPath: string
  /** Page that signs staff in (login and 2FA). Opened in a new tab from the card. */
  signInUrl: string
}

/** A path prefix on the page's own origin: absolute, no trailing slash, no scheme. */
const pathPrefix = z.string().pattern(/^\/(?:[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*)?$/)

/** Settings as written in cordis.yml: only the server name is required; the paths default. */
export const Config: z<Partial<Config> & Pick<Config, 'serverName'>, Config> = z.object({
  serverName: z.string().pattern(/^[A-Za-z0-9_-]{1,32}$/).required(),
  toolsPath: pathPrefix.default('/tools/pending'),
  apiPath: pathPrefix.default('/api/v1'),
  // An absolute path on this origin: the card never navigates to another site.
  signInUrl: pathPrefix.default('/login'),
})

/** Required services: the slot registry and the locale registry. */
export const inject = ['slots', 'locale']

/**
 * Client plugin body: register the dictionary and one card per prepare tool.
 * @param ctx - client root context.
 * @param config - deployment settings.
 */
export function apply(ctx: ClientContext, config: Config): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-ai-confirm: dictionaries')
  const store = createConfirmStore()
  const api = createConfirmApi({
    // Late-bound so a test or a hot reload that replaces the global fetch is honored per call.
    fetch: (input, init) => globalThis.fetch(input, init),
    toolsPath: config.toolsPath,
    apiPath: config.apiPath,
  })
  for (const spec of ACTIONS) {
    ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
      {
        name: 'tool.call.toolview',
        key: wireName(config.serverName, spec),
        locale: NS,
        store,
        inject: () => ({ api, spec, signInUrl: config.signInUrl }),
      },
      ConfirmCard,
    ))
  }
}
