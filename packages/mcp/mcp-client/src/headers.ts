/**
 * Per-call HTTP headers for Streamable HTTP: an optional `mcpHeaders` service
 * supplies headers for one tool call, and a fetch wrapper overlays them on that
 * call's requests only. Header values are never logged or put in error text.
 *
 * @module
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'

/** Optional provider of HTTP headers for one MCP tool call. */
export interface McpHeaders {
  /**
   * Headers for one call; they win over the configured static headers.
   * A throw fails only that call, before any request is sent.
   */
  headersFor(serverName: string, exec: ToolExecution): Promise<Record<string, string>> | Record<string, string>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Optional per-call header provider read by mcp-client; provided by other plugins. */
    mcpHeaders?: McpHeaders
  }
}

// The SDK's callTool options and transport.send accept no per-request headers from callers,
// so the current call's headers travel through async context to the fetch wrapper.
const callHeaders = new AsyncLocalStorage<Readonly<Record<string, string>>>()

/** Run `run` with `headers` overlaid on every request it causes. */
export function withCallHeaders<T>(headers: Readonly<Record<string, string>>, run: () => Promise<T>): Promise<T> {
  return callHeaders.run(headers, run)
}

/**
 * Fetch that overlays the current call's headers, if any, onto POST requests only.
 * The shared standalone stream (GET) and session close (DELETE) keep the static headers,
 * even when started from inside a call's async context.
 */
export const fetchWithCallHeaders: typeof fetch = (input, init) => {
  const extra = callHeaders.getStore()
  if (extra === undefined || (init?.method ?? 'GET').toUpperCase() !== 'POST') return fetch(input, init)
  const headers = new Headers(init?.headers)
  for (const [name, value] of Object.entries(extra)) headers.set(name, value)
  return fetch(input, { ...init, headers })
}
