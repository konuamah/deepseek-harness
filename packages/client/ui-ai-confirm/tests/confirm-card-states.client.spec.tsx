// @vitest-environment jsdom

/** The card when the batch cannot be used, and when it remounts. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ConfirmApiError, type ConfirmApi } from '../src/client/api.ts'
import { ConfirmCard } from '../src/client/ConfirmCard.tsx'
import { SUMMARIES, fakeApi, newStore, props, settle } from './fixtures.tsx'

afterEach(cleanup)

describe('when the batch cannot be used', () => {
  it('asks staff to sign in, links to the sign-in page, and reloads on retry', async () => {
    const store = newStore()
    let signedIn = false
    const { api } = fakeApi()
    const flaky: ConfirmApi = {
      ...api,
      loadPending: async (id) => { if (!signedIn) throw new ConfirmApiError('sign-in'); return api.loadPending(id) },
    }
    render(<ConfirmCard {...props({ store, api: flaky })} />)
    await settle()

    expect(screen.getByText(/You are not signed in/)).toBeTruthy()
    const link = screen.getByRole('link', { name: 'Sign in' })
    expect(link.getAttribute('href')).toBe('/login')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull()

    signedIn = true
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await settle()

    expect(screen.queryByText(/You are not signed in/)).toBeNull()
    expect(screen.getByText('Ama Mensah')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeTruthy()
  })

  it('explains an expired or used batch and still shows each application’s current status', async () => {
    const { api } = fakeApi({ pending: 'expired', summaries: SUMMARIES.map(summary => ({ ...summary, status: 'APPROVED' })) })

    render(<ConfirmCard {...props({ store: newStore(), api })} />)
    await settle()

    expect(screen.getByText(/This batch has expired or was already used/)).toBeTruthy()
    expect(screen.getAllByText('Approved')).toHaveLength(2)
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  })

  it('says when the admissions system did not answer, and offers to try again', async () => {
    const { api } = fakeApi({ pending: 'unavailable' })

    render(<ConfirmCard {...props({ store: newStore(), api })} />)
    await settle()

    expect(screen.getByText(/did not answer/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
  })

  it('says when the account may not confirm, with no retry', async () => {
    const { api } = fakeApi({ pending: 'refused' })

    render(<ConfirmCard {...props({ store: newStore(), api })} />)
    await settle()

    expect(screen.getByText(/This account cannot confirm this action/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  })

  it('stops with sign-in, before using the batch up, when the token cannot be minted', async () => {
    const { api, calls } = fakeApi({ mint: 'sign-in' })
    render(<ConfirmCard {...props({ store: newStore(), api })} />)
    await settle()

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await settle()

    expect(calls).not.toContain('claim')
    expect(screen.getByText(/You are not signed in/)).toBeTruthy()
  })

  it('shows the batch as used when it was taken between the load and the click', async () => {
    const { api, calls } = fakeApi({ claim: 'expired' })
    render(<ConfirmCard {...props({ store: newStore(), api })} />)
    await settle()

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await settle()

    expect(calls.some(call => call.startsWith('write:'))).toBe(false)
    expect(screen.getByText(/This batch has expired or was already used/)).toBeTruthy()
  })
})

describe('remounting', () => {
  it('shows the stored state instead of loading again', async () => {
    const store = newStore()
    const { api, calls } = fakeApi()
    const first = render(<ConfirmCard {...props({ store, api })} />)
    await settle()
    first.unmount()

    render(<ConfirmCard {...props({ store, api })} />)
    await settle()

    expect(calls.filter(call => call === 'loadPending')).toHaveLength(1)
    expect(screen.getByText('Ama Mensah')).toBeTruthy()
  })

  it('keeps a confirm running when the card unmounts, and shows its result when it comes back', async () => {
    const store = newStore()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { api } = fakeApi()
    const slow: ConfirmApi = { ...api, claim: async () => { await gate } }
    const first = render(<ConfirmCard {...props({ store, api: slow })} />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await settle()
    first.unmount()

    release()
    await settle()
    await settle()
    render(<ConfirmCard {...props({ store, api: slow })} />)
    await settle()

    expect(screen.getByText('Changed: 2 of 2')).toBeTruthy()
  })
})
