/**
 * Per-Session interaction state of the confirm cards: where each batch is in its flow, the reason
 * staff are editing, and the outcome of each write. A card can remount while a confirm is running,
 * so this state lives here and not in the component. The Slot registry owns store instances; this
 * module exports only the factory.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { ApplicationFile, FailureKind, PendingView, RecordOutcome, Summary } from './api.ts'

/** Where a batch is in its flow. A failure kind is a stop the card explains. */
export type CardPhase = 'loading' | 'ready' | 'confirming' | 'done' | 'cancelled' | FailureKind

/** The step a running confirm is on. */
export type ConfirmStep = 'token' | 'claim' | 'write'

/** One batch's interaction state, keyed by the tool service's pending action id. */
export interface CardState {
  readonly phase: CardPhase
  /** The batch as the tool service holds it; null until it has loaded. */
  readonly pending: PendingView | null
  readonly summaries: readonly Summary[]
  /** The reason as staff have edited it. */
  readonly reason: string
  /** Retyped by staff, never populated from the tool result or persisted. */
  readonly confirmReference: string
  /** Whether staff have typed in the reason, so a reload does not overwrite their words. */
  readonly edited: boolean
  readonly step: ConfirmStep | null
  readonly results: Readonly<Record<number, RecordOutcome>>
}

/** Names of one read card's applications: loading, loaded (id to name), or failed (shown without names). */
export interface ListState {
  readonly phase: 'loading' | 'ready' | 'failed'
  readonly names: Readonly<Record<number, string>>
}

/** Files loaded for one get_application call. */
export interface FilesState {
  readonly phase: 'loading' | 'ready' | FailureKind
  readonly documents: readonly ApplicationFile[]
}

/** One staff card's stacking facts: where it sits in a turn and which applications it shows. */
export interface TurnCard {
  readonly seq: number
  readonly callId: string
  readonly applicationIds: readonly number[]
  readonly loaded: boolean
}

/** All cards of one Session: batches keyed by pending action id, application lists keyed by call id. */
export interface ConfirmState {
  cards: Record<string, CardState>
  lists: Record<string, ListState>
  files: Record<string, FilesState>
  collapsed: Record<string, boolean>
  /** Staff cards per turn, ordered by event sequence, for hiding a card a later one supersedes. */
  turns: Record<number, readonly TurnCard[]>
}

/** What the controller needs from the store: one method per state change. */
export interface CardSink {
  begin(key: string): void
  loaded(key: string, pending: PendingView, summaries: readonly Summary[]): void
  failed(key: string, kind: FailureKind): void
  summaries(key: string, summaries: readonly Summary[]): void
  editReason(key: string, reason: string): void
  editReference(key: string, reference: string): void
  confirming(key: string, step: ConfirmStep): void
  recorded(key: string, id: number, outcome: RecordOutcome): void
  finished(key: string): void
  cancelled(key: string): void
  listBegin(key: string): void
  listLoaded(key: string, names: Readonly<Record<number, string>>): void
  listFailed(key: string): void
  filesBegin(key: string): void
  filesLoaded(key: string, documents: readonly ApplicationFile[]): void
  filesFailed(key: string, kind: FailureKind): void
}

type ConfirmActions = {
  [Name in keyof CardSink]: (state: ConfirmState, ...args: Parameters<CardSink[Name]>) => void
} & {
  collapse(state: ConfirmState, key: string, collapsed: boolean): void
  seeCard(state: ConfirmState, turn: number, card: TurnCard): void
}

/** A card that has not loaded anything yet. */
export const EMPTY_CARD: CardState = {
  phase: 'loading',
  pending: null,
  summaries: [],
  reason: '',
  confirmReference: '',
  edited: false,
  step: null,
  results: {},
}

function card(state: ConfirmState, key: string): CardState {
  return state.cards[key] ?? EMPTY_CARD
}

function update(state: ConfirmState, key: string, change: Partial<CardState>): void {
  state.cards[key] = { ...card(state, key), ...change }
}

/**
 * Declare the confirm cards' Session store.
 * @returns a store handle whose instance is owned by the Slot registry.
 */
export function createConfirmStore(): EngineStoreHandle<ConfirmState, ConfirmActions> {
  return defineStore({
    init: (): ConfirmState => ({ cards: {}, lists: {}, files: {}, collapsed: {}, turns: {} }),
    actions: {
      collapse: (state, key, collapsed) => { state.collapsed[key] = collapsed },
      seeCard: (state, turn, card) => {
        const list = state.turns[turn] ?? []
        const index = list.findIndex(existing => existing.callId === card.callId)
        const next = index === -1 ? [...list, card] : list.map((existing, i) => i === index ? card : existing)
        state.turns = { ...state.turns, [turn]: next }
      },
      begin: (state, key) => {
        // Reopening keeps what staff typed and any outcomes already recorded.
        update(state, key, { phase: 'loading', step: null })
      },
      loaded: (state, key, pending, summaries) => {
        const current = card(state, key)
        update(state, key, {
          phase: 'ready',
          pending,
          summaries,
          // Staff words win over the AI's draft once they have typed.
          reason: current.edited ? current.reason : pending.reason,
        })
      },
      failed: (state, key, kind) => {
        update(state, key, { phase: kind, step: null })
      },
      summaries: (state, key, summaries) => {
        update(state, key, { summaries })
      },
      editReason: (state, key, reason) => {
        update(state, key, { reason, edited: true })
      },
      editReference: (state, key, confirmReference) => {
        update(state, key, { confirmReference })
      },
      confirming: (state, key, step) => {
        update(state, key, { phase: 'confirming', step })
      },
      recorded: (state, key, id, outcome) => {
        update(state, key, { results: { ...card(state, key).results, [id]: outcome } })
      },
      finished: (state, key) => {
        update(state, key, { phase: 'done', step: null })
      },
      cancelled: (state, key) => {
        update(state, key, { phase: 'cancelled', step: null })
      },
      listBegin: (state, key) => {
        state.lists[key] = { phase: 'loading', names: {} }
      },
      listLoaded: (state, key, names) => {
        state.lists[key] = { phase: 'ready', names }
      },
      listFailed: (state, key) => {
        state.lists[key] = { phase: 'failed', names: {} }
      },
      filesBegin: (state, key) => {
        state.files[key] = { phase: 'loading', documents: [] }
      },
      filesLoaded: (state, key, documents) => {
        state.files[key] = { phase: 'ready', documents }
      },
      filesFailed: (state, key, kind) => {
        state.files[key] = { phase: kind, documents: [] }
      },
    },
  })
}
