/** Shared fixtures for the card specs: a scripted API, a real store, and the card's props. */
import { useSyncExternalStore } from 'react'
import { act } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { ConfirmApiError, type ApplicationSummary, type ConfirmApi, type DocumentSummary, type FailureKind, type PendingView, type RecordOutcome, type Summary } from '../src/client/api.ts'
import { createConfirmStore } from '../src/client/confirm-store.ts'
import type { ConfirmCardProps } from '../src/client/ConfirmCard.tsx'
import { en } from '../src/client/locales.ts'
import { ACTIONS, type ActionSpec } from '../src/client/model.ts'

export const [APPROVE, REJECT, REQUEST_DOCUMENTS, CANCEL, VERIFY_DOCUMENT, REJECT_DOCUMENT, ENROLL, SEND_OFFER] = ACTIONS as [
  ActionSpec, ActionSpec, ActionSpec, ActionSpec, ActionSpec, ActionSpec, ActionSpec, ActionSpec,
]
export const KEY = '0b1d2c3e-4f50-4a61-8b72-93a4b5c6d7e8'
export const t = makeTranslate(en)

export const SUMMARIES: readonly ApplicationSummary[] = [
  { id: 7, name: 'Ama Mensah', reference: 'APP-7', status: 'UNDER_REVIEW', program: { code: 'NUR', name: 'Nursing' } },
  { id: 8, name: 'Kofi Owusu', reference: 'APP-8', status: 'PENDING', program: { code: 'NUR', name: 'Nursing' } },
]

export const DOC_SUMMARIES: readonly DocumentSummary[] = [
  { id: 12, name: 'Ama Fakename', reference: 'APP2026001', documentType: 'Transcript', status: 'PENDING', previewable: true },
  { id: 13, name: '', reference: 'APP2026002', documentType: 'Passport', status: 'PENDING', previewable: false },
]

interface Batch {
  eligible?: { id: number; status: string }[]
  skipped?: { id: number; status: string | null; why: string }[]
  action?: string
}

/** The text a prepare tool returns. */
export const batchText = (over: Batch = {}): string =>
  JSON.stringify({
    pendingActionId: KEY,
    action: over.action ?? 'application.approve',
    eligible: over.eligible ?? [{ id: 7, status: 'UNDER_REVIEW' }, { id: 8, status: 'PENDING' }],
    skipped: over.skipped ?? [],
    expiresAt: '2026-11-03T15:00:00.000Z',
  })

export interface Script {
  pending?: Partial<PendingView> | FailureKind
  summaries?: readonly Summary[] | FailureKind
  documents?: readonly import('../src/client/api.ts').ApplicationFile[] | FailureKind
  mint?: FailureKind
  claim?: FailureKind
  writes?: Record<number, RecordOutcome>
}

/** A scripted API; `calls` records the order the card used it in, `minted` what it asked a token for. */
export function fakeApi(script: Script = {}) {
  const calls: string[] = []
  const resources: (string | undefined)[] = []
  const minted: { ids: readonly number[]; reason: string; confirmReference?: string }[] = []
  const fail = (kind: FailureKind): never => { throw new ConfirmApiError(kind) }
  const api: ConfirmApi = {
    async loadPending(id) {
      calls.push('loadPending')
      const pending = script.pending
      if (typeof pending === 'string') return fail(pending)
      return { id, action: 'application.approve', ids: [7, 8], reason: 'AI draft', expiresAt: 'x', ...pending }
    },
    async loadSummaries(_ids, resource) {
      calls.push('loadSummaries')
      resources.push(resource)
      const summaries = script.summaries ?? SUMMARIES
      return typeof summaries === 'string' ? fail(summaries) : summaries
    },
    async loadDocuments() {
      calls.push('loadDocuments')
      const documents = script.documents ?? []
      return typeof documents === 'string' ? fail(documents) : documents
    },
    documentUrl(kind, id, mode) { return `/api/v1/admissions/staff/documents/${kind}/${id}/${mode}/` },

    async claim() {
      calls.push('claim')
      if (script.claim !== undefined) fail(script.claim)
    },
    async mintWriteToken(spec, ids, reason, confirmReference = '') {
      calls.push('mint')
      if (script.mint !== undefined) fail(script.mint)
      minted.push({ ids, reason, ...(spec.confirmReference ? { confirmReference } : {}) })
      return 'write-token'
    },
    async write(_spec, id) {
      calls.push(`write:${id}`)
      return script.writes?.[id] ?? { ok: true }
    },
  }
  return { api, calls, minted, resources }
}

export const newStore = () => createConfirmStore().create('session')

type Store = ReturnType<typeof newStore>

/** The card's props, built the way the framework hands them over, with a store hook that re-renders. */
export function props(over: {
  store: Store
  api: ConfirmApi
  spec?: ActionSpec
  text?: string
  isError?: boolean
  phase?: 'start' | 'result'
}): ConfirmCardProps {
  const { store, api, spec = APPROVE, text = batchText(), isError = false, phase = 'result' } = over
  return {
    phase,
    text,
    isError,
    toolName: `mcp__cinhed__${spec.tool}`,
    callId: 'call-1',
    t,
    useStore: (selector: (state: ReturnType<Store['getSnapshot']>) => unknown) =>
      useSyncExternalStore(listener => store.subscribe(listener), () => selector(store.getSnapshot())),
    actions: store.actions,
    api,
    spec,
    signInUrl: '/login',
  } as never
}

/** Let the pending promises and the re-render they cause finish. */
export async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve() })
}
