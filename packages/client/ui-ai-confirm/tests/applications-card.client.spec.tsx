// @vitest-environment jsdom

/** The read-only applications card: names from the staff call, never from the AI result. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { createConfirmApi, type ApplicationSummary, type ConfirmApi } from '../src/client/api.ts'
import { ApplicationsCard, type ApplicationsCardProps } from '../src/client/ApplicationsCard.tsx'
import { fakeApi, newStore, props, settle } from './fixtures.tsx'

afterEach(cleanup)

const program = { code: 'NUR', name: 'Nursing' }
const AMA: ApplicationSummary = { id: 7, name: 'Ama Mensah', reference: 'APP-7', status: 'UNDER_REVIEW', program }
const KOFI: ApplicationSummary = { id: 8, name: 'Kofi Owusu', reference: 'APP-8', status: 'PENDING', program }

const row = (id: number, status = 'UNDER_REVIEW') => ({
  id, reference: `APP-${id}`, status, program: { id: 1, code: 'NUR', name: 'Nursing' },
  intakeName: null, submittedAt: null, decidedAt: null, documents: [],
})
const listText = (ids = [7, 8]) => JSON.stringify({ total: ids.length, page: 1, hasMore: false, applications: ids.map(id => row(id, id === 8 ? 'PENDING' : 'UNDER_REVIEW')) })

/** The card's props: the same payload the prepare cards get, whose api face is all this card reads. */
const view = (over: Parameters<typeof props>[0], toolName = 'mcp__cinhed__list_applications'): ApplicationsCardProps => ({ ...props(over), toolName })

function counting(api: ConfirmApi) {
  const asked: (readonly number[])[] = []
  return { api: { ...api, loadSummaries: async (ids: readonly number[]) => { asked.push(ids); return api.loadSummaries(ids) } }, asked }
}

describe('applications card', () => {
  it('shows names, reference, status and program, asking once with the right ids', async () => {
    const wrapped = counting(fakeApi().api)

    render(<ApplicationsCard {...view({ store: newStore(), api: wrapped.api, text: listText() })} />)
    await settle()

    expect(screen.getByText('Ama Mensah')).toBeTruthy()
    expect(screen.getByText('Kofi Owusu')).toBeTruthy()
    expect(screen.getByText('APP-7')).toBeTruthy()
    expect(screen.getByText('Under review')).toBeTruthy()
    expect(screen.getByText('Pending review')).toBeTruthy()
    expect(screen.getAllByText('Nursing')).toHaveLength(2)
    expect(screen.getByText('2 applications')).toBeTruthy()
    expect(wrapped.asked).toEqual([[7, 8]])
  })

  it('does not ask again when the card remounts', async () => {
    const { api, asked } = counting(fakeApi().api)
    const store = newStore()
    const first = render(<ApplicationsCard {...view({ store, api, text: listText() })} />)
    await settle()
    first.unmount()

    render(<ApplicationsCard {...view({ store, api, text: listText() })} />)
    await settle()

    expect(asked).toHaveLength(1)
    expect(screen.getByText('Ama Mensah')).toBeTruthy()
  })

  it('works for get_application, whose result is one application', async () => {
    const { api, asked } = counting(fakeApi().api)

    render(<ApplicationsCard {...view({ store: newStore(), api, text: JSON.stringify(row(7)) }, 'mcp__cinhed__get_application')} />)
    await settle()

    expect(asked).toEqual([[7]])
    expect(screen.getByText('1 application')).toBeTruthy()
    expect(screen.getByText('Ama Mensah')).toBeTruthy()
    expect(asked).toHaveLength(1)
  })

  it('loads and displays staff files only for get_application', async () => {
    const documents = [
      { id: 2, kind: 'uploaded' as const, title: '<img src=x onerror=alert(1)>', status: 'PENDING', availableToApplicant: true, previewable: true },
      { id: 3, kind: 'official' as const, title: 'Offer letter', status: null, availableToApplicant: false, previewable: false },
    ]
    const base = fakeApi({ documents })
    const api = { ...base.api, documentUrl: (kind: string, id: number, mode: string) => `/api/v1/admissions/staff/documents/${kind}/${id}/${mode}/` }
    const { container } = render(<ApplicationsCard {...view({ store: newStore(), api, text: JSON.stringify(row(7)) }, 'mcp__cinhed__get_application')} />)
    await settle()

    expect(base.calls).toContain('loadDocuments')
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(container.querySelectorAll('img')).toHaveLength(0)
    expect(screen.getByText('Not released to applicant')).toBeTruthy()
    expect(screen.getAllByRole('link', { name: 'View' })).toHaveLength(1)
    expect(screen.getAllByRole('link', { name: 'Download' })).toHaveLength(2)
    expect(screen.getAllByRole('link', { name: 'Download' })[1]?.getAttribute('href')).toContain('/official/3/download/')
    expect(screen.getAllByRole('link', { name: 'View' })[0]?.getAttribute('target')).toBe('_blank')
    expect(screen.getAllByRole('link', { name: 'View' })[0]?.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('shows files loading until the asynchronous request settles', async () => {
    let release: () => void = () => {}
    const { api } = fakeApi()
    const slow: ConfirmApi = { ...api, loadDocuments: () => new Promise((resolve) => { release = () => { resolve([]) } }) }

    render(<ApplicationsCard {...view({ store: newStore(), api: slow, text: JSON.stringify(row(7)) }, 'mcp__cinhed__get_application')} />)

    expect(screen.getByText('Loading files')).toBeTruthy()
    release()
    await settle()

    expect(screen.getByText('No files are available.')).toBeTruthy()
  })

  it('shows the generic file failure and retries only on click', async () => {
    const { api, calls } = fakeApi({ documents: 'unavailable' })
    render(<ApplicationsCard {...view({ store: newStore(), api, text: JSON.stringify(row(7)) }, 'mcp__cinhed__get_application')} />)
    await settle()

    expect(screen.getByText('Files could not be loaded. Try again.')).toBeTruthy()
    expect(calls.filter(call => call === 'loadDocuments')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await settle()
    expect(calls.filter(call => call === 'loadDocuments')).toHaveLength(2)
  })

  it('shows the empty file state and does not reload files when get_application remounts', async () => {
    const { api, calls } = fakeApi({ documents: [] })
    const store = newStore()
    const appView = view({ store, api, text: JSON.stringify(row(7)) }, 'mcp__cinhed__get_application')
    const first = render(<ApplicationsCard {...appView} />)
    await settle()
    expect(screen.getByText('No files are available.')).toBeTruthy()
    first.unmount()
    render(<ApplicationsCard {...appView} />)
    await settle()
    expect(calls.filter(call => call === 'loadDocuments')).toHaveLength(1)
  })

  it('does not load files for a one-row list_applications result', async () => {
    const { api, calls } = fakeApi()
    render(<ApplicationsCard {...view({ store: newStore(), api, text: JSON.stringify(row(7)) })} />)
    await settle()
    expect(calls).toEqual(['loadSummaries'])
  })

  it('shows sign-in guidance and retries file loading on click', async () => {
    const { api, calls } = fakeApi({ documents: 'sign-in' })
    render(<ApplicationsCard {...view({ store: newStore(), api, text: JSON.stringify(row(7)) }, 'mcp__cinhed__get_application')} />)
    await settle()
    expect(screen.getByText('Sign in, then try loading the files again.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await settle()
    expect(calls.filter(call => call === 'loadDocuments')).toHaveLength(2)
  })

  it('shows the rows without names while loading', () => {
    const { api } = fakeApi()

    render(<ApplicationsCard {...view({ store: newStore(), api, text: listText() })} />)

    expect(screen.getByText('APP-7')).toBeTruthy()
    expect(screen.getAllByText('—')).toHaveLength(2)
    expect(screen.getAllByText('Loading names').length).toBeGreaterThan(0)
  })

  it.each(['sign-in', 'expired', 'unavailable'] as const)('fails soft on %s, keeps the rows and retries only on click', async (kind) => {
    const script = { summaries: kind } as const
    const { api, calls } = fakeApi(script)

    render(<ApplicationsCard {...view({ store: newStore(), api, text: listText() })} />)
    await settle()

    expect(screen.getByText('Names could not be loaded. Reference, status and program are still shown.')).toBeTruthy()
    expect(screen.getByText('APP-8')).toBeTruthy()
    expect(screen.queryByText('Ama Mensah')).toBeNull()
    expect(calls).toEqual(['loadSummaries'])

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await settle()
    expect(calls).toEqual(['loadSummaries', 'loadSummaries'])
  })

  it('treats a name that looks like an email address as missing', async () => {
    const summaries: ApplicationSummary[] = [{ ...AMA, name: 'ama@example.com' }, KOFI]
    const { api } = fakeApi({ summaries })

    const { container } = render(<ApplicationsCard {...view({ store: newStore(), api, text: listText() })} />)
    await settle()

    expect(container.textContent).not.toContain('ama@example.com')
    expect(screen.getByText('Kofi Owusu')).toBeTruthy()
  })

  it.each([
    ['not json', 'nope'],
    ['JSON that is not an object', '[1]'],
    ['an object with neither shape', '{"hello":1}'],
    ['an empty list', JSON.stringify({ applications: [] })],
    ['a row with a bad field', JSON.stringify({ applications: [{ ...row(7), reference: 3 }] })],
    ['a row without a program', JSON.stringify({ applications: [{ id: 7, reference: 'A', status: 'PENDING' }] })],
    ['more than 25 rows', listText(Array.from({ length: 26 }, (_, index) => index + 1))],
  ])('renders nothing for %s and asks for nothing', async (_label, text) => {
    const { api, calls } = fakeApi()

    const { container } = render(<ApplicationsCard {...view({ store: newStore(), api, text })} />)
    await settle()

    expect(container.innerHTML).toBe('')
    expect(calls).toEqual([])
  })

  it('renders nothing while the call runs or when it errored', async () => {
    const { api, calls } = fakeApi()

    const running = render(<ApplicationsCard {...view({ store: newStore(), api, phase: 'start' })} />)
    const errored = render(<ApplicationsCard {...view({ store: newStore(), api, text: listText(), isError: true })} />)
    await settle()

    expect(running.container.innerHTML).toBe('')
    expect(errored.container.innerHTML).toBe('')
    expect(calls).toEqual([])
  })

  it('reads only id and name from the summaries payload, so extra fields never reach the DOM', async () => {
    const extra = { ...AMA, email: 'ama@example.com', phone: '0551234567', idNumber: 'GHA-123', address: '1 High St' }
    const fetched: string[] = []
    const api = createConfirmApi({
      fetch: (async (url: string) => {
        fetched.push(url)
        return new Response(JSON.stringify({ applications: [extra] }), { status: 200 })
      }) as typeof fetch,
      toolsPath: '/tools/pending',
      apiPath: '/api/v1',
    })

    const { container } = render(<ApplicationsCard {...view({ store: newStore(), api, text: JSON.stringify(row(7)) })} />)
    await settle()

    expect(fetched).toEqual(['/api/v1/admissions/staff/application-summaries/?ids=7'])
    expect(container.textContent).toContain('Ama Mensah')
    for (const secret of ['ama@example.com', '0551234567', 'GHA-123', '1 High St']) {
      expect(container.textContent).not.toContain(secret)
    }
  })
})
