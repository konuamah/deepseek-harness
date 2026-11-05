// @vitest-environment jsdom
/** Visible card disclosure keeps the card mounted and never repeats a pending action. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CardNode } from '../src/client/CardNode.tsx'
import { batchText, fakeApi, newStore, props, REJECT, settle } from './fixtures.tsx'

afterEach(cleanup)

function view(
  store: ReturnType<typeof newStore>, api: ReturnType<typeof fakeApi>['api'],
  overrides: Partial<Parameters<typeof props>[0]> = {},
) {
  const { callId, toolName, phase, text, isError, ...shared } = props({ store, api, ...overrides })
  return {
    ...shared, serverName: 'cinhed',
    node: {
      key: 'card-1', id: callId, kind: 'ai-confirm-card' as const, target: 'chat' as const,
      anchorSeq: 2, location: { kind: 'unresolved' as const }, groupTree: 'turn' as const,
      visibility: 'visible' as const, data: { callId, toolName, phase, text, isError, applicationIds: [] },
    },
  }
}

/** A Chat node placed in turn 1, for the stacking tests. */
function turnView(
  store: ReturnType<typeof newStore>, api: ReturnType<typeof fakeApi>['api'],
  overrides: Partial<Parameters<typeof props>[0]> & {
    callId: string; toolName: string; seq: number; applicationIds: readonly number[]; loaded: boolean
  },
) {
  const { callId, toolName, seq, applicationIds, loaded, ...rest } = overrides
  const { callId: _c, toolName: _t, phase, text, isError, ...shared } = props({ store, api, ...rest })
  return {
    ...shared, serverName: 'cinhed',
    node: {
      key: `card-${callId}`, id: callId, kind: 'ai-confirm-card' as const, target: 'chat' as const,
      anchorSeq: seq, location: { kind: 'step', turn: { turn: 1 }, step: { step: 1 } } as never,
      groupTree: 'turn' as const, visibility: 'visible' as const,
      data: { callId, toolName, phase: loaded ? 'result' as const : 'start' as const, text, isError: !loaded, applicationIds },
    },
  }
}

it('opens by default, remembers collapse across remount, and isolates sessions', async () => {
  const store = newStore()
  const { api, calls } = fakeApi()
  const first = render(<CardNode {...view(store, api)} />)
  await settle()
  const hide = screen.getByRole('button', { name: 'Hide details' })
  expect(hide.getAttribute('aria-expanded')).toBe('true')
  fireEvent.click(hide)
  expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull()
  expect(store.getSnapshot().collapsed['call-1']).toBe(true)
  first.unmount()
  const second = render(<CardNode {...view(store, api)} />)
  fireEvent.click(screen.getByRole('button', { name: 'Show details' }))
  expect(screen.getByRole('button', { name: 'Confirm' })).toBeTruthy()
  expect(calls.filter(call => call === 'loadPending')).toHaveLength(1)
  second.unmount()
  render(<CardNode {...view(newStore(), api)} />)
  expect(screen.getByRole('button', { name: 'Hide details' })).toBeTruthy()
  await settle()
})

it('keeps the edited reason and an in-flight confirmation across collapse', async () => {
  let release = () => {}
  const pending = new Promise<void>((resolve) => { release = resolve })
  const { api, calls, minted } = fakeApi()
  const claim = vi.fn(async () => { await pending; await api.claim('batch') })
  render(<CardNode {...view(newStore(), { ...api, claim }, {
    spec: REJECT, text: batchText({ action: 'application.reject' }),
  })} />)
  await settle()
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Staff reason' } })
  fireEvent.click(screen.getByRole('button', { name: 'Hide details' }))
  fireEvent.click(screen.getByRole('button', { name: 'Show details' }))
  expect(screen.getByRole('textbox').getAttribute('disabled')).toBeNull()
  expect(screen.getByRole('textbox')).toHaveProperty('value', 'Staff reason')
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
  await settle()
  fireEvent.click(screen.getByRole('button', { name: 'Hide details' }))
  fireEvent.click(screen.getByRole('button', { name: 'Show details' }))
  expect(screen.getByRole('button', { name: 'Confirm' }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('textbox').hasAttribute('disabled')).toBe(true)
  expect(claim).toHaveBeenCalledTimes(1)
  expect(calls.some(call => call.startsWith('write:'))).toBe(false)
  release()
  await settle()
  expect(minted).toEqual([{ ids: [7, 8], reason: 'Staff reason' }])
  expect(calls.filter(call => call.startsWith('write:'))).toEqual(['write:7', 'write:8'])
  expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull()
})

it('keeps sign-in guidance visible across collapse without offering a write', async () => {
  const { api, calls } = fakeApi({ pending: 'sign-in' })
  render(<CardNode {...view(newStore(), api)} />)
  await settle()
  expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/login')
  fireEvent.click(screen.getByRole('button', { name: 'Hide details' }))
  fireEvent.click(screen.getByRole('button', { name: 'Show details' }))
  expect(screen.getByRole('link', { name: 'Sign in' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull()
  expect(calls.some(call => call === 'mint' || call === 'claim' || call.startsWith('write:'))).toBe(false)
})

it('keeps cancellation one-use when collapsed and reopened', async () => {
  const { api, calls } = fakeApi()
  render(<CardNode {...view(newStore(), api)} />)
  await settle()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  await settle()
  fireEvent.click(screen.getByRole('button', { name: 'Hide details' }))
  fireEvent.click(screen.getByRole('button', { name: 'Show details' }))
  expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull()
  expect(calls.filter(call => call === 'claim')).toHaveLength(1)
  expect(calls.some(call => call.startsWith('write:'))).toBe(false)
})

it('never offers Confirm again after a write finishes', async () => {
  const { api, calls } = fakeApi()
  render(<CardNode {...view(newStore(), api)} />)
  await settle()
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
  await settle()
  fireEvent.click(screen.getByRole('button', { name: 'Hide details' }))
  fireEvent.click(screen.getByRole('button', { name: 'Show details' }))
  expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull()
  expect(calls.filter(call => call === 'claim')).toHaveLength(1)
  expect(calls.filter(call => call.startsWith('write:'))).toEqual(['write:7', 'write:8'])
})

const ONE_APP = JSON.stringify({ applications: [{ id: 7, reference: 'APP-7', status: 'DRAFT', program: { name: 'Nursing' } }] })
const ONE_BATCH = batchText({ eligible: [{ id: 7, status: 'UNDER_REVIEW' }] })

describe('card stacking in one turn', () => {
  it('hides the earlier search card when a later loaded action card shows the same application', async () => {
    const store = newStore()
    const { api } = fakeApi()
    render(<CardNode {...turnView(store, api, { callId: 'search', toolName: 'mcp__cinhed__list_applications', seq: 2, applicationIds: [7], loaded: true, text: ONE_APP })} />)
    render(<CardNode {...turnView(store, api, { callId: 'action', toolName: 'mcp__cinhed__prepare_approve', seq: 3, applicationIds: [7], loaded: true, text: ONE_BATCH })} />)
    await settle()

    expect(screen.queryByText('1 application')).toBeNull()
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeTruthy()
  })

  it('keeps the earlier card when the later card has not loaded', async () => {
    const store = newStore()
    const { api } = fakeApi()
    render(<CardNode {...turnView(store, api, { callId: 'search', toolName: 'mcp__cinhed__list_applications', seq: 2, applicationIds: [7], loaded: true, text: ONE_APP })} />)
    render(<CardNode {...turnView(store, api, { callId: 'action', toolName: 'mcp__cinhed__prepare_approve', seq: 3, applicationIds: [7], loaded: false, text: '' })} />)
    await settle()

    expect(screen.getByText('1 application')).toBeTruthy()
  })

  it('keeps a two-application list when a later card shows only one', async () => {
    const store = newStore()
    const { api } = fakeApi()
    const two = JSON.stringify({ applications: [
      { id: 7, reference: 'APP-7', status: 'DRAFT', program: { name: 'Nursing' } },
      { id: 8, reference: 'APP-8', status: 'DRAFT', program: { name: 'Nursing' } },
    ] })
    render(<CardNode {...turnView(store, api, { callId: 'search', toolName: 'mcp__cinhed__list_applications', seq: 2, applicationIds: [7, 8], loaded: true, text: two })} />)
    render(<CardNode {...turnView(store, api, { callId: 'action', toolName: 'mcp__cinhed__prepare_approve', seq: 3, applicationIds: [7], loaded: true, text: ONE_BATCH })} />)
    await settle()

    expect(screen.getByText('2 applications')).toBeTruthy()
  })

  it('never hides an action card, so a pending confirm is not lost', async () => {
    const store = newStore()
    const { api } = fakeApi()
    render(<CardNode {...turnView(store, api, { callId: 'first', toolName: 'mcp__cinhed__prepare_approve', seq: 2, applicationIds: [7], loaded: true, text: ONE_BATCH })} />)
    render(<CardNode {...turnView(store, api, { callId: 'second', toolName: 'mcp__cinhed__prepare_cancel', seq: 3, applicationIds: [7], loaded: true, text: batchText({ action: 'application.cancel', eligible: [{ id: 7, status: 'DRAFT' }] }) })} />)
    await settle()

    expect(screen.getAllByRole('button', { name: 'Confirm' })).toHaveLength(2)
  })
})
