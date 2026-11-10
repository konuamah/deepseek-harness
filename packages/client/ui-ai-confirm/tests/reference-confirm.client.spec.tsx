// @vitest-environment jsdom

/** Irreversible actions require a browser-entered reference and exactly one application. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ConfirmCard } from '../src/client/ConfirmCard.tsx'
import { confirmCard } from '../src/client/controller.ts'
import { parsePrepared } from '../src/client/model.ts'
import { ENROLL, KEY, SEND_OFFER, SUMMARIES, batchText, fakeApi, newStore, props, settle } from './fixtures.tsx'

afterEach(cleanup)

const LABEL = 'Retype the application reference to confirm'
const REASON = 'Reason for manual enrolment (staff only)'
const eligible = [{ id: 7, status: 'APPROVED' }]

function setup(spec = ENROLL, summaries = SUMMARIES) {
  const store = newStore()
  const fake = fakeApi({ pending: { action: spec.action, ids: [7], reason: 'Staff decision' }, summaries })
  const cardProps = props({ store, api: fake.api, spec, text: batchText({ action: spec.action, eligible }) })
  return { store, ...fake, cardProps }
}

describe('reference-confirmed cards', () => {
  it.each([ENROLL, SEND_OFFER])('requires the exact reference for $tool', async (spec) => {
    const { cardProps, minted } = setup(spec)
    render(<ConfirmCard {...cardProps} />)
    await settle()
    const confirm = screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement
    const field = screen.getByRole('textbox', { name: LABEL })
    expect(confirm.disabled).toBe(true)
    expect(screen.getByText('Enter APP-7 exactly.')).toBeTruthy()
    fireEvent.change(field, { target: { value: 'APP-8' } })
    expect(confirm.disabled).toBe(true)
    expect(field.getAttribute('aria-invalid')).toBe('true')
    fireEvent.change(field, { target: { value: ' APP-7 ' } })
    expect(confirm.disabled).toBe(true)
    fireEvent.change(field, { target: { value: 'APP-7' } })
    expect(confirm.disabled).toBe(false)
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    await settle()
    expect(minted).toEqual([{ ids: [7], reason: spec === ENROLL ? 'Staff decision' : '', confirmReference: 'APP-7' }])
  })

  it('shows the irreversible enrolment warning and requires a staff reason', async () => {
    const { cardProps } = setup()
    render(<ConfirmCard {...cardProps} />)
    await settle()
    expect(screen.getByText('No payment is needed. This creates the student ID and a semester invoice. It cannot be undone.')).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: LABEL }), { target: { value: 'APP-7' } })
    fireEvent.change(screen.getByRole('textbox', { name: REASON }), { target: { value: '   ' } })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Confirm' }).disabled).toBe(true)
  })

  it('does not offer a status transition to sent for offer send', async () => {
    const { cardProps } = setup(SEND_OFFER)
    render(<ConfirmCard {...cardProps} />)
    await settle()
    expect(screen.getByText('The offer letter is emailed to the applicant. This cannot be undone.')).toBeTruthy()
    expect(screen.queryByText(/→/)).toBeNull()
  })

  it('refuses confirmation when the staff summary is missing', async () => {
    const { cardProps } = setup(ENROLL, [])
    render(<ConfirmCard {...cardProps} />)
    await settle()
    expect(screen.getByText('The reference could not be checked. Reopen the request.')).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Confirm' }).disabled).toBe(true)
  })

  it('keeps the reference on a card remount, but not in a different session', async () => {
    const { cardProps, store } = setup()
    const first = render(<ConfirmCard {...cardProps} />)
    await settle()
    fireEvent.change(screen.getByRole('textbox', { name: LABEL }), { target: { value: 'APP-7' } })
    first.unmount()
    render(<ConfirmCard {...cardProps} />)
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: LABEL }).value).toBe('APP-7')
    expect(store.getSnapshot().cards[KEY]?.confirmReference).toBe('APP-7')
    expect(newStore().getSnapshot().cards).toEqual({})
  })

  it('does not allow a malformed multi-record batch through the card', async () => {
    const { cardProps } = setup()
    render(<ConfirmCard {...cardProps} text={batchText({ action: ENROLL.action })} />)
    await settle()
    fireEvent.change(screen.getByRole('textbox', { name: LABEL }), { target: { value: 'APP-7' } })
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Confirm' }).disabled).toBe(true)
  })

  it.each([{ ids: [7, 8] }, { ids: [7] }])('refuses missing confirmation before mint or claim for $ids', async ({ ids }) => {
    const { api, calls } = fakeApi()
    const batch = parsePrepared(batchText({ action: ENROLL.action, eligible }))!
    await confirmCard(api, newStore().actions, ENROLL, batch, ids, 'Staff decision')
    expect(calls).toEqual([])
  })
})
