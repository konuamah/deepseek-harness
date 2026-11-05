/**
 * Per-Session interaction state of the confirm cards: where each batch is in its flow, the reason
 * staff are editing, and the outcome of each write. A card can remount while a confirm is running,
 * so this state lives here and not in the component. The Slot registry owns store instances; this
 * module exports only the factory.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { ApplicationSummary, FailureKind, PendingView, RecordOutcome } from './api.ts'

/** Where a batch is in its flow. A failure kind is a stop the card explains. */
export type CardPhase = 'loading' | 'ready' | 'confirming' | 'done' | 'cancelled' | FailureKind

/** The step a running confirm is on. */
export type ConfirmStep = 'token' | 'claim' | 'write'

/** One batch's interaction state, keyed by the tool service's pending action id. */
export interface CardState {
  readonly phase: CardPhase
  /** The batch as the tool service holds it; null until it has loaded. */
  readonly pending: PendingView | null
  readonly summaries: readonly ApplicationSummary[]
  /** The reason as staff have edited it. */
  readonly reason: string
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

/** All cards of one Session: batches keyed by pending action id, application lists keyed by call id. */
export interface ConfirmState {
  cards: Record<string, CardState>
  lists: Record<string, ListState>
}

/** What the controller needs from the store: one method per state change. */
export interface CardSink {
  begin(key: string): void
  loaded(key: string, pending: PendingView, summaries: readonly ApplicationSummary[]): void
  failed(key: string, kind: FailureKind): void
  summaries(key: string, summaries: readonly ApplicationSummary[]): void
  editReason(key: string, reason: string): void
  confirming(key: string, step: ConfirmStep): void
  recorded(key: string, id: number, outcome: RecordOutcome): void
  finished(key: string): void
  cancelled(key: string): void
  listBegin(key: string): void
  listLoaded(key: string, names: Readonly<Record<number, string>>): void
  listFailed(key: string): void
}

type ConfirmActions = {
  [Name in keyof CardSink]: (state: ConfirmState, ...args: Parameters<CardSink[Name]>) => void
}

/** A card that has not loaded anything yet. */
export const EMPTY_CARD: CardState = {
  phase: 'loading',
  pending: null,
  summaries: [],
  reason: '',
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
    init: (): ConfirmState => ({ cards: {}, lists: {} }),
    actions: {
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
    },
  })
}
