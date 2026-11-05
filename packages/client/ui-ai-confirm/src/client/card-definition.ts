/** Incremental staff-card presentation from existing tool events; constant work per event. */
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import { shownApplicationIds } from './model.ts'

/** Logged tool values used by staff cards, without tool-group presentation state. */
export interface CardData {
  readonly callId: string
  readonly toolName: string
  readonly phase: 'start' | 'result'
  readonly text: string
  readonly isError: boolean
  /** Application ids the card shows; empty until a read result parses, or when the result is malformed. */
  readonly applicationIds: readonly number[]
}

interface CardState extends CardData {
  readonly seq: number
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    /** A staff application or prepared-action card outside the process group. */
    'ai-confirm-card': CardData
  }
}

/**
 * Match configured tools by call id, including results loaded before their call during history paging.
 * @param toolNames - Exact MCP wire names owned by this plugin.
 * @returns A disposable-registration-ready Chat definition.
 */
export function createCardDefinition(toolNames: readonly string[]): ConversationNodeDefinition<CardState> {
  const names = new Set(toolNames)
  return {
    kind: 'ai-confirm-card',
    target: 'chat',
    match: (event) => {
      if (event.type === 'tool/call' && names.has(event.data.name)) {
        return { id: String(event.data.callId), role: 'start' }
      }
      // Results omit tool names; unmatched updates never create a visible node.
      if (event.type === 'tool/result' && isAppendSurfaceEvent(event)) {
        return { id: String(event.data.message.source.callId), role: 'update' }
      }
      return null
    },
    start: (_context, match) => {
      const event = match.event
      if (event.type !== 'tool/call') throw new Error('Staff card requires tool/call')
      return { callId: String(event.data.callId), toolName: event.data.name,
        seq: event.seq, phase: 'start', text: '', isError: false,
        applicationIds: shownApplicationIds(event.data.name, event.data.arguments, '') }
    },
    update: (context, match) => {
      if (match.event.type !== 'tool/result') return context.state
      const message = match.event.data.message
      const text = message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n')
      const name = context.state.toolName.split('__').at(-1)
      const isRead = name === 'list_applications' || name === 'get_application'
      return { ...context.state, phase: 'result', isError: message.isError === true, text,
        applicationIds: isRead ? shownApplicationIds(context.state.toolName, undefined, text) : context.state.applicationIds }
    },
    buildViewNode: (context) => {
      if (context.state === undefined) return null
      const { seq, ...data } = context.state
      return {
        key: context.key, id: context.id, kind: 'ai-confirm-card', target: 'chat',
        anchorSeq: seq, location: context.start?.location ?? { kind: 'unresolved' },
        groupTree: 'turn', visibility: 'visible', data,
      }
    },
  }
}
