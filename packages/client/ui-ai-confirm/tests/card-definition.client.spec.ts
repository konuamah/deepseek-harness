/** Replay and append semantics for staff Chat cards. */
import { describe, expect, it } from 'vitest'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import { ConversationNodeAssembler } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ConversationViewNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { createCardDefinition } from '../src/client/card-definition.ts'

const call = (seq: number, callId: string, name = 'mcp__cinhed__list_applications') => ({
  type: 'tool/call', seq: SessionSeq(seq), time: seq,
  data: { turn: 1, step: 2, callId, name, arguments: '{}' },
}) as never

const result = (seq: number, callId: string, text: string, isError = false) => ({
  type: 'tool/result', seq: SessionSeq(seq), time: seq, surfaceOp: 'append',
  data: { turn: 1, step: 2, message: {
    role: 'tool', isError, source: { kind: 'tool', callId },
    content: [{ type: 'text', text }, { type: 'image', url: 'ignored' }, { type: 'text', text: 'second' }],
  } },
}) as never

function assembler() {
  let nodes: readonly ConversationViewNode[] = []
  const definition = createCardDefinition(['mcp__cinhed__list_applications'])
  const instance = new ConversationNodeAssembler(
    { entries: () => [definition], fallbackEntry: () => undefined },
    { entries: () => [{ target: 'chat', create: () => ({
      empty: nodes,
      replace: input => (nodes = input.nodes),
      apply: (input) => {
        const updated = new Map(nodes.map(node => [node.key, node]))
        for (const node of input.upserts) updated.set(node.key, node)
        return (nodes = [...updated.values()])
      },
    }) }] },
  )
  instance.activateTarget('chat')
  return { instance, snapshot: () => nodes }
}

const input = (event: never) => ({ type: 'event' as const, event })

describe('createCardDefinition', () => {
  it('replays calls and results to the keyed Chat node with call anchor and turn grouping', () => {
    const run = assembler()
    run.instance.replaceWindow([
      input(call(1, 'c1')),
      input(result(2, 'c1', 'first')),
      input(call(3, 'other', 'mcp__other__list_applications')),
      input(call(4, 'prepare', 'mcp__cinhed__prepare_approve')),
    ], false)
    run.instance.flush()

    expect(typeof run.snapshot()[0]?.key).toBe('string')
    expect(run.snapshot()).toMatchObject([{
      id: 'c1', kind: 'ai-confirm-card', target: 'chat',
      anchorSeq: SessionSeq(1), location: { kind: 'step', turn: { turn: 1 }, step: { step: 2 } },
      groupTree: 'turn', visibility: 'visible',
      data: { callId: 'c1', toolName: 'mcp__cinhed__list_applications', phase: 'result', text: 'first\nsecond', isError: false, applicationIds: [] },
    }])
  })

  it('associates a result loaded before its matching call when older history is prepended', () => {
    const run = assembler()
    run.instance.replaceWindow([input(result(8, 'late', 'loaded result'))], true)
    run.instance.flush()
    expect(run.snapshot()).toEqual([])

    run.instance.prepend([input(call(3, 'late'))], false)
    run.instance.flush()
    expect(run.snapshot()[0]).toMatchObject({
      anchorSeq: SessionSeq(3), groupTree: 'turn',
      data: { callId: 'late', phase: 'result', text: 'loaded result\nsecond', isError: false },
    })
  })

  it('retains error results as mixed text and does not create cards for unmatched results', () => {
    const run = assembler()
    run.instance.replaceWindow([
      input(call(5, 'failed')),
      input(result(6, 'failed', 'denied', true)),
      input(result(7, 'unknown', 'orphan')),
    ], false)
    run.instance.flush()

    expect(run.snapshot()).toHaveLength(1)
    expect(run.snapshot()[0]?.data).toEqual({
      callId: 'failed', toolName: 'mcp__cinhed__list_applications',
      phase: 'result', text: 'denied\nsecond', isError: true, applicationIds: [],
    })
  })
})
