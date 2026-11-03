// @vitest-environment jsdom

/** The confirm card as staff see it: what it loads, what it asks, what it does on each click. */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ConfirmApi, RecordOutcome } from '../src/client/api.ts'
import { ConfirmCard } from '../src/client/ConfirmCard.tsx'
import { APPROVE, REJECT, REQUEST_DOCUMENTS, batchText, fakeApi, newStore, props, settle } from './fixtures.tsx'

afterEach(cleanup)

const REASON = 'Reason (may be sent to the applicant)'

describe('while the tool call runs or fails', () => {
  it.each(['preparing', 'start'] as const)('shows a quiet row in the %s phase', (phase) => {
    const { api } = fakeApi()

    render(<ConfirmCard {...props({ store: newStore(), api, phase })} />)

    expect(screen.getAllByText('Preparing a batch').length).toBeGreaterThan(0)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('shows the tool service’s own words when nothing could be prepared', () => {
    const { api, calls } = fakeApi()
    const text = 'Nothing can be prepared. Skipped: 3 (APPROVED: cannot be approved from this status).'

    render(<ConfirmCard {...props({ store: newStore(), api, text, isError: true })} />)

    expect(screen.getByText('Could not prepare a batch')).toBeTruthy()
    expect(screen.getByText(text)).toBeTruthy()
    expect(calls).toEqual([])
  })

  it('shows a failure row, not a card, when the result is not a batch', () => {
    const { api, calls } = fakeApi()

    render(<ConfirmCard {...props({ store: newStore(), api, text: 'not a batch' })} />)

    expect(screen.getByText('Could not prepare a batch')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
    expect(calls).toEqual([])
  })

  it('shows only the failure line when the failed result has no text', () => {
    const { api } = fakeApi()

    const view = render(<ConfirmCard {...props({ store: newStore(), api, text: '', isError: true })} />)

    expect(screen.getByText('Could not prepare a batch')).toBeTruthy()
    expect(view.container.querySelectorAll('p')).toHaveLength(1)
  })
})

describe('a prepared batch', () => {
  it('loads once and shows names, references, programs and the change each record will get', async () => {
    const { api, calls } = fakeApi()

    render(<ConfirmCard {...props({ store: newStore(), api })} />)
    await settle()

    expect(screen.getByRole('heading', { name: 'Approve 2 applications' })).toBeTruthy()
    const records = within(screen.getByRole('list', { name: 'Applications in this batch' }))
    expect(records.getByText('Ama Mensah')).toBeTruthy()
    expect(records.getByText('APP-7 · NUR')).toBeTruthy()
    expect(records.getByText('Under review → Approved')).toBeTruthy()
    expect(records.getByText('Pending review → Approved')).toBeTruthy()
    expect(calls).toEqual(['loadPending', 'loadSummaries'])
  })

  it.each([
    [APPROVE, 'application.approve', 'Approve 1 application', 'Approve 2 applications'],
    [REJECT, 'application.reject', 'Reject 1 application', 'Reject 2 applications'],
    [REQUEST_DOCUMENTS, 'application.request_documents', 'Ask for documents on 1 application', 'Ask for documents on 2 applications'],
  ] as const)('titles the %s card for one and for several applications', async (spec, action, one, many) => {
    const { api } = fakeApi()
    const single = render(<ConfirmCard {...props({ store: newStore(), api, spec, text: batchText({ action, eligible: [{ id: 7, status: 'UNDER_REVIEW' }] }) })} />)
    await settle()
    expect(screen.getByRole('heading', { name: one })).toBeTruthy()
    single.unmount()

    render(<ConfirmCard {...props({ store: newStore(), api, spec, text: batchText({ action }) })} />)
    await settle()
    expect(screen.getByRole('heading', { name: many })).toBeTruthy()
  })

  it('names a record Django did not return by its number, and shows an unknown status as it is', async () => {
    const { api } = fakeApi({ summaries: [] })

    render(<ConfirmCard {...props({ store: newStore(), api, text: batchText({ eligible: [{ id: 7, status: 'SOMETHING_NEW' }] }) })} />)
    await settle()

    expect(screen.getByText('Application 7')).toBeTruthy()
    expect(screen.getByText('SOMETHING_NEW → Approved')).toBeTruthy()
  })

  it('lists what was skipped and why', async () => {
    const { api } = fakeApi()
    const skipped = [
      { id: 9, status: 'APPROVED', why: 'cannot be approved from this status' },
      { id: 999, status: null, why: 'not found' },
    ]

    render(<ConfirmCard {...props({ store: newStore(), api, text: batchText({ skipped }) })} />)
    await settle()

    expect(screen.getByText('Skipped')).toBeTruthy()
    expect(screen.getByText('Application 9')).toBeTruthy()
    expect(screen.getByText('Approved')).toBeTruthy()
    expect(screen.getByText('cannot be approved from this status')).toBeTruthy()
    expect(screen.getByText('not found')).toBeTruthy()
  })

  it('has no reason field for an approval', async () => {
    const { api } = fakeApi()

    render(<ConfirmCard {...props({ store: newStore(), api })} />)
    await settle()

    expect(screen.queryByLabelText(REASON)).toBeNull()
  })
})

describe('confirming', () => {
  it('writes each record in order and says how many were changed', async () => {
    const { api, calls } = fakeApi()
    render(<ConfirmCard {...props({ store: newStore(), api })} />)
    await settle()

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await settle()
    await settle()

    expect(calls).toEqual(['loadPending', 'loadSummaries', 'mint', 'claim', 'write:7', 'write:8', 'loadSummaries'])
    expect(screen.getAllByText('Changed')).toHaveLength(2)
    expect(screen.getByText('Changed: 2 of 2')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull()
  })

  it('disables both buttons and shows its step while it runs', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { api } = fakeApi()
    const slow: ConfirmApi = { ...api, mintWriteToken: async (...args) => { await gate; return api.mintWriteToken(...args) } }
    render(<ConfirmCard {...props({ store: newStore(), api: slow })} />)
    await settle()

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await settle()

    expect(screen.getByRole('button', { name: 'Confirm' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getAllByText('Checking your sign-in').length).toBeGreaterThan(0)
    release()
    await settle()
    await settle()
    expect(screen.getByText('Changed: 2 of 2')).toBeTruthy()
  })

  it('shows the step it is on while it reserves the batch and while it writes', async () => {
    const { api } = fakeApi()
    let releaseClaim: () => void = () => {}
    const claimGate = new Promise<void>((resolve) => { releaseClaim = resolve })
    let releaseWrite: () => void = () => {}
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve })
    const stepped: ConfirmApi = {
      ...api,
      claim: async () => { await claimGate },
      write: async (spec, id, token, reason) => { if (id === 8) await writeGate; return api.write(spec, id, token, reason) },
    }
    render(<ConfirmCard {...props({ store: newStore(), api: stepped })} />)
    await settle()

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await settle()
    expect(screen.getAllByText('Reserving the batch').length).toBeGreaterThan(0)
    releaseClaim()
    await settle()
    expect(screen.getAllByText('Applying changes: 1 of 2').length).toBeGreaterThan(0)
    releaseWrite()
    await settle()
    await settle()
    expect(screen.getByText('Changed: 2 of 2')).toBeTruthy()
  })

  it('shows what Django said about a record it would not change, and still changes the others', async () => {
    const writes: Record<number, RecordOutcome> = {
      7: { ok: false, kind: 'rejected', detail: 'An application with status "Approved" cannot be approved.' },
      8: { ok: true },
    }
    const { api } = fakeApi({ writes })
    render(<ConfirmCard {...props({ store: newStore(), api })} />)
    await settle()

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await settle()
    await settle()

    expect(screen.getByText('Not changed: An application with status "Approved" cannot be approved.')).toBeTruthy()
    expect(screen.getByText('Changed')).toBeTruthy()
    expect(screen.getByText('Changed: 1 of 2')).toBeTruthy()
  })

  it.each([
    [{ ok: false, kind: 'rejected', detail: '' }, 'Not changed'],
    [{ ok: false, kind: 'refused' }, 'Not allowed'],
    [{ ok: false, kind: 'missing' }, 'Not found'],
    [{ ok: false, kind: 'unavailable' }, 'No answer, check its status'],
  ] as [RecordOutcome, string][])('labels the outcome %j as "%s"', async (outcome, label) => {
    const { api } = fakeApi({ pending: { ids: [7] }, writes: { 7: outcome } })
    render(<ConfirmCard {...props({ store: newStore(), api, text: batchText({ eligible: [{ id: 7, status: 'UNDER_REVIEW' }] }) })} />)
    await settle()

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await settle()
    await settle()

    expect(screen.getByText(label)).toBeTruthy()
    expect(screen.getByText('Changed: 0 of 1')).toBeTruthy()
  })
})

describe('the reason', () => {
  const rejectCard = (api: ConfirmApi) =>
    render(<ConfirmCard {...props({ store: newStore(), api, spec: REJECT, text: batchText({ action: 'application.reject' }) })} />)

  it('starts from the AI’s draft, takes staff edits, and sends exactly what staff finalised', async () => {
    const { api, minted } = fakeApi()
    rejectCard(api)
    await settle()
    const field = screen.getByLabelText(REASON) as HTMLTextAreaElement
    expect(field.value).toBe('AI draft')

    fireEvent.change(field, { target: { value: '  Passport unreadable  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await settle()
    await settle()

    expect(minted).toEqual([{ ids: [7, 8], reason: 'Passport unreadable' }])
  })

  it('lets a reject go ahead with no reason, since it is optional', async () => {
    const { api, minted } = fakeApi({ pending: { reason: '' } })
    rejectCard(api)
    await settle()

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await settle()
    await settle()

    expect(minted).toEqual([{ ids: [7, 8], reason: '' }])
  })

  it('will not confirm a request for documents without a reason', async () => {
    const { api, minted } = fakeApi({ pending: { reason: '' } })
    render(<ConfirmCard {...props({ store: newStore(), api, spec: REQUEST_DOCUMENTS, text: batchText({ action: 'application.request_documents' }) })} />)
    await settle()
    const confirm = screen.getByRole('button', { name: 'Confirm' })
    const field = screen.getByLabelText(REASON)
    expect(confirm.hasAttribute('disabled')).toBe(true)
    expect(screen.getByText('A reason is required.')).toBeTruthy()
    expect(field.getAttribute('aria-invalid')).toBe('true')
    expect(field.getAttribute('aria-describedby')).toBe(screen.getByText('A reason is required.').id)

    fireEvent.change(field, { target: { value: 'Clearer scan' } })

    expect(confirm.hasAttribute('disabled')).toBe(false)
    expect(screen.queryByText('A reason is required.')).toBeNull()
    expect(field.getAttribute('aria-describedby')).toBeNull()
    fireEvent.click(confirm)
    await settle()
    await settle()
    expect(minted).toEqual([{ ids: [7, 8], reason: 'Clearer scan' }])
  })

  it('stops accepting edits while the confirm runs', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { api } = fakeApi()
    rejectCard({ ...api, claim: async () => { await gate } })
    await settle()

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    await settle()

    expect(screen.getByLabelText(REASON).hasAttribute('disabled')).toBe(true)
    release()
    await settle()
    await settle()
  })
})

describe('cancelling', () => {
  it('uses the batch up without writing and says nothing was changed', async () => {
    const { api, calls } = fakeApi()
    render(<ConfirmCard {...props({ store: newStore(), api })} />)
    await settle()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await settle()

    expect(calls).toEqual(['loadPending', 'loadSummaries', 'claim'])
    expect(screen.getByText('Cancelled. Nothing was changed.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull()
  })
})
