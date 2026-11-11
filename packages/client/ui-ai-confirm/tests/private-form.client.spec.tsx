// @vitest-environment jsdom
// oxlint-disable typescript/unbound-method -- mock methods are handed to the component, not borrowed.
/** Private form behavior: click-only writes, unknown outcomes stay locked, uploads and drafts. */
import { useState, useSyncExternalStore } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApplicationFormError, type ApplicationCatalog, type ApplicationFormApi, type UploadTarget } from '../src/client/application-form-api.ts'
import { createConfirmStore, EMPTY_FORM } from '../src/client/confirm-store.ts'
import { parseFormMarker, type FormMarker } from '../src/client/model.ts'
import { en } from '../src/client/locales.ts'
import type { OfferDraft, OfferFormApi } from '../src/client/offer-form-api.ts'
import { PrivateForm } from '../src/client/PrivateForm.tsx'

afterEach(cleanup)

const t = makeTranslate(en)
const catalog: ApplicationCatalog = {
  page: 1, hasMore: false,
  programs: [{ id: 2, name: 'Nursing' }], intakes: [{ id: 3, name: 'Autumn' }],
  scholarships: [{ id: 5, name: 'Merit' }],
  documents: [
    { id: 4, name: 'Transcript', isRequired: true, acceptedFormats: 'pdf,png', maxSizeMb: 5 },
    { id: 6, name: 'Passport', isRequired: true, acceptedFormats: 'pdf,png', maxSizeMb: 5 },
  ],
}
const target: UploadTarget = { id: 7, reference: 'APP-7', status: 'UNDER_REVIEW', attachedDocumentTypeIds: [4] }
const draft: OfferDraft = {
  id: 9, application: 7, status: 'DRAFT', currency: 'GHS',
  tuition_fee: '1000.00', registration_fee: '0.00', admission_fee: '0.00', accommodation_fee: '0.00',
  exam_assessment_fee: '0.00', student_services_fee: '0.00', graduation_exit_fee: '0.00', other_fees: '0.00',
  other_fees_description: '', program_duration: '', study_mode: '', program_start_date: null,
  partner_institution: '', prepared_by_name: '', requires_visa_flight: false, notes: '',
  offer_scholarships: [{ scholarship: 5, amount: '10.00', notes: '' }],
  total_fees: '1000.00', total_scholarships: '10.00', net_fee_payable: '990.00',
}

function applicationApi(over: Partial<ApplicationFormApi> = {}) {
  const api: ApplicationFormApi = {
    catalog: vi.fn(async () => catalog),
    creationAvailable: vi.fn(async () => true),
    target: vi.fn(async () => target),
    create: vi.fn(async () => ({ id: 9, reference: 'APP-9', status: 'PENDING', createdNew: true })),
    upload: vi.fn(async () => undefined),
    reconcile: vi.fn(async () => null),
    ...over,
  }
  return api
}

function offerApi(loaded: OfferDraft | null = null, over: Partial<OfferFormApi> = {}) {
  const api: OfferFormApi = {
    load: vi.fn(async () => loaded),
    save: vi.fn(async () => draft),
    previewUrl: vi.fn((id: number) => `/api/v1/admissions/staff/applications/${id}/offer/preview/`),
    ...over,
  }
  return api
}

function Harness({ form, application = applicationApi(), offer = offerApi() }: {
  readonly form: FormMarker
  readonly application?: ApplicationFormApi
  readonly offer?: OfferFormApi
}) {
  const [store] = useState(() => createConfirmStore().create('session'))
  const state = useSyncExternalStore(
    listener => store.subscribe(listener), () => store.getSnapshot().forms['call-form'] ?? EMPTY_FORM,
  )
  const locks = useSyncExternalStore(listener => store.subscribe(listener), () => store.getSnapshot().locks)
  return <PrivateForm form={form} callId="call-form" state={state} locks={locks} applicationApi={application}
    offerApi={offer} actions={store.actions} t={t} signInUrl="/login" />
}

function fillApplication() {
  const values: Record<string, string> = {
    'First name': 'Ama', 'Last name': 'Mensah', 'Date of birth': '2000-01-02', 'Place of birth': 'Accra',
    'Passport or national ID number': 'GHA-1', 'Email address': 'ama@example.test', 'Address': '1 Road',
    'City': 'Accra', 'Country': 'Ghana', 'Postal code': 'GA1', 'Highest qualification': 'WASSCE',
    'Institution attended': 'School', 'Year completed': '2020',
  }
  for (const [label, value] of Object.entries(values)) fireEvent.change(screen.getByLabelText(label), { target: { value } })
  fireEvent.change(screen.getByLabelText('Program'), { target: { value: '2' } })
  fireEvent.change(screen.getByLabelText('Intake'), { target: { value: '3' } })
}

async function ready(label: string) {
  await waitFor(() => { expect(screen.getByLabelText(label)).toBeTruthy() })
}

describe('form markers', () => {
  it('accepts only well-formed application and offer markers', () => {
    expect(parseFormMarker('mcp__cinhed__open_application_form', '{"form":"application","applicationId":null}'))
      .toEqual({ form: 'application', applicationId: null })
    expect(parseFormMarker('mcp__cinhed__open_application_form', '{"form":"application","applicationId":7}'))
      .toEqual({ form: 'application', applicationId: 7 })
    expect(parseFormMarker('mcp__cinhed__open_offer_form', '{"form":"offer","applicationId":7}'))
      .toEqual({ form: 'offer', applicationId: 7 })
    for (const text of ['{"form":"application","applicationId":0}', '{"form":"offer"}', '{"form":"offer","applicationId":"7"}', 'not json']) {
      expect(parseFormMarker('mcp__cinhed__open_offer_form', text)).toBeNull()
    }
    expect(parseFormMarker('mcp__cinhed__get_application', '{"form":"offer","applicationId":7}')).toBeNull()
  })
})

describe('application form', () => {
  it('loads choices without writing, then creates once with values and a file', async () => {
    const api = applicationApi()
    render(<Harness form={{ form: 'application', applicationId: null }} application={api} />)
    await ready('First name')
    expect(api.create).not.toHaveBeenCalled()

    fillApplication()
    fireEvent.click(screen.getByRole('checkbox', { name: /accepted the terms/ }))
    fireEvent.change(screen.getByLabelText(/Transcript/), {
      target: { files: [new File(['%PDF synthetic'], 'transcript.pdf', { type: 'application/pdf' })] },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create application' }))

    await waitFor(() => { expect(api.create).toHaveBeenCalledTimes(1) })
    const body = vi.mocked(api.create).mock.calls[0]![0]
    expect(body.get('first_name')).toBe('Ama')
    expect(body.get('program')).toBe('2')
    expect(body.get('accepted_terms')).toBe('true')
    expect((body.get('document_4') as File).name).toBe('transcript.pdf')
    await waitFor(() => {
      expect(screen.getByText(en['form.application.created'].replace('{reference}', 'APP-9'))).toBeTruthy()
    })
  })

  it('reports a duplicate without uploading files or changing identity', async () => {
    const api = applicationApi({
      create: vi.fn(async () => ({ id: 9, reference: 'APP-9', status: 'PENDING', createdNew: false })),
    })
    render(<Harness form={{ form: 'application', applicationId: null }} application={api} />)
    await ready('First name')
    fillApplication()
    fireEvent.click(screen.getByRole('checkbox', { name: /accepted the terms/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Create application' }))
    await waitFor(() => { expect(api.create).toHaveBeenCalledTimes(1) })
    await waitFor(() => {
      expect(screen.getByText(en['form.application.duplicate'].replace('{reference}', 'APP-9'))).toBeTruthy()
    })
    expect(api.upload).not.toHaveBeenCalled()
  })

  it('keeps an unknown outcome locked and never retries', async () => {
    const create = vi.fn(async () => { throw new ApplicationFormError('unknown') })
    const api = applicationApi({ create })
    render(<Harness form={{ form: 'application', applicationId: null }} application={api} />)
    await ready('First name')
    fillApplication()
    fireEvent.click(screen.getByRole('checkbox', { name: /accepted the terms/ }))
    const submit = screen.getByRole('button', { name: 'Create application' })
    fireEvent.click(submit)
    await waitFor(() => { expect(screen.getByText(en['form.error.unknown'])).toBeTruthy() })
    expect(submit).toHaveProperty('disabled', true)
    fireEvent.click(submit)
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('uploads only to types not already attached', async () => {
    const api = applicationApi()
    render(<Harness form={{ form: 'application', applicationId: 7 }} application={api} />)
    await waitFor(() => { expect(screen.getByText(/Already attached · Transcript/)).toBeTruthy() })
    expect(screen.queryByLabelText(/Transcript/)).toBeNull()
    fireEvent.change(screen.getByLabelText(/Passport/), {
      target: { files: [new File(['%PDF synthetic'], 'passport.pdf', { type: 'application/pdf' })] },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Upload documents' }))
    await waitFor(() => { expect(api.upload).toHaveBeenCalledTimes(1) })
    const [id, body] = vi.mocked(api.upload).mock.calls[0]!
    expect(id).toBe(7)
    expect(body.has('document_6')).toBe(true)
    expect(body.has('document_4')).toBe(false)
  })

  it('writes once when Submit is clicked twice', async () => {
    const create = vi.fn(async () => ({ id: 9, reference: 'APP-9', status: 'PENDING', createdNew: true }))
    const api = applicationApi({ create })
    render(<Harness form={{ form: 'application', applicationId: null }} application={api} />)
    await ready('First name')
    fillApplication()
    fireEvent.click(screen.getByRole('checkbox', { name: /accepted the terms/ }))
    const submit = screen.getByRole('button', { name: 'Create application' })
    fireEvent.click(submit)
    fireEvent.click(submit)
    await waitFor(() => { expect(create).toHaveBeenCalledTimes(1) })
  })

  it('warns before discarding a dirty form', async () => {
    render(<Harness form={{ form: 'application', applicationId: null }} />)
    await ready('First name')
    fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Ama' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByText(en['form.discard'])).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(screen.getByLabelText<HTMLInputElement>('First name').value).toBe('')
  })
})

describe('offer form', () => {
  it('does not save on mount and omits blank new tuition', async () => {
    const api = offerApi(null)
    render(<Harness form={{ form: 'offer', applicationId: 7 }} offer={api} />)
    await ready('Registration fee')
    expect(api.save).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('Registration fee'), { target: { value: '100.00' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }))
    await waitFor(() => { expect(api.save).toHaveBeenCalledTimes(1) })
    const [id, body, create] = vi.mocked(api.save).mock.calls[0]!
    expect(id).toBe(7)
    expect(create).toBe(true)
    expect(body).toEqual({ registration_fee: '100.00' })
  })

  it('loads an existing draft and saves an explicit scholarship removal', async () => {
    const api = offerApi(draft)
    render(<Harness form={{ form: 'offer', applicationId: 7 }} offer={api} />)
    await ready('Tuition fee')
    expect(screen.getByLabelText<HTMLInputElement>('Tuition fee').value).toBe('1000.00')
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save draft' }))
    await waitFor(() => { expect(api.save).toHaveBeenCalledTimes(1) })
    const [, body, create] = vi.mocked(api.save).mock.calls[0]!
    expect(create).toBe(false)
    expect(body).toEqual({ offer_scholarships: [] })
  })

  it('previews the saved draft and hides the action while edits are unsaved', async () => {
    render(<Harness form={{ form: 'offer', applicationId: 7 }} offer={offerApi(draft)} />)
    await ready('Tuition fee')
    const link = screen.getByRole('link', { name: 'Preview offer letter' })
    expect(link.getAttribute('href')).toBe('/api/v1/admissions/staff/applications/7/offer/preview/')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')

    fireEvent.change(screen.getByLabelText('Tuition fee'), { target: { value: '1200.00' } })
    expect(screen.queryByRole('link', { name: 'Preview offer letter' })).toBeNull()
    expect(screen.getByText(en['form.offer.previewSaveFirst'])).toBeTruthy()
  })

  it('offers no preview before the draft is saved', async () => {
    render(<Harness form={{ form: 'offer', applicationId: 7 }} offer={offerApi(null)} />)
    await ready('Registration fee')
    expect(screen.queryByRole('link', { name: 'Preview offer letter' })).toBeNull()
  })

  it('keeps an unknown save locked and never retries', async () => {
    const save = vi.fn(async () => { throw new ApplicationFormError('unknown') })
    render(<Harness form={{ form: 'offer', applicationId: 7 }} offer={offerApi(draft, { save })} />)
    await ready('Tuition fee')
    fireEvent.change(screen.getByLabelText('Tuition fee'), { target: { value: '1200.00' } })
    const submit = screen.getByRole('button', { name: 'Save draft' })
    fireEvent.click(submit)
    await waitFor(() => { expect(screen.getByText(en['form.error.unknown'])).toBeTruthy() })
    expect(submit).toHaveProperty('disabled', true)
    fireEvent.click(submit)
    expect(save).toHaveBeenCalledTimes(1)
  })
})
