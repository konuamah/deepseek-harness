/** The confirm flow against a scripted API and a real store: order of steps, and what each failure leaves behind. */
import { describe, expect, it } from 'vitest'
import {
  ConfirmApiError, type ApplicationSummary, type ConfirmApi, type FailureKind, type PendingView, type RecordOutcome,
} from '../src/client/api.ts'
import { cancelCard, confirmCard, openCard } from '../src/client/controller.ts'
import { createConfirmStore, EMPTY_CARD } from '../src/client/confirm-store.ts'
import { ACTIONS, type PreparedBatch } from '../src/client/model.ts'

const [APPROVE, REJECT] = ACTIONS as [(typeof ACTIONS)[0], (typeof ACTIONS)[1]]
const KEY = '0b1d2c3e-4f50-4a61-8b72-93a4b5c6d7e8'

const BATCH: PreparedBatch = {
  pendingActionId: KEY,
  action: 'application.approve',
  eligible: [{ id: 7, status: 'UNDER_REVIEW' }, { id: 8, status: 'PENDING' }],
  skipped: [],
  expiresAt: '2026-11-03T15:00:00.000Z',
}
const PENDING: PendingView = { id: KEY, action: 'application.approve', ids: [7, 8], reason: 'AI draft', expiresAt: BATCH.expiresAt }
const SUMMARIES: readonly ApplicationSummary[] = [
  { id: 7, name: 'Ama Mensah', reference: 'APP-7', status: 'UNDER_REVIEW', program: { code: 'NUR', name: 'Nursing' } },
  { id: 8, name: 'Kofi Owusu', reference: 'APP-8', status: 'PENDING', program: { code: 'NUR', name: 'Nursing' } },
]
const AFTER: readonly ApplicationSummary[] = SUMMARIES.map(summary => ({ ...summary, status: 'APPROVED' }))

interface Script {
  pending?: PendingView | FailureKind
  summaries?: readonly ApplicationSummary[] | FailureKind
  refreshed?: readonly ApplicationSummary[] | FailureKind
  mintFails?: FailureKind
  claim?: FailureKind
  writes?: Record<number, RecordOutcome>
}

/** A fake API driven by a script; `calls` records the order the controller used it in. */
function fakeApi(script: Script): { api: ConfirmApi; calls: string[] } {
  const calls: string[] = []
  const fail = (kind: FailureKind): never => { throw new ConfirmApiError(kind) }
  const api: ConfirmApi = {
    async loadPending() {
      calls.push('loadPending')
      const { pending = PENDING } = script
      return typeof pending === 'string' ? fail(pending) : pending
    },
    async loadSummaries() {
      // Statuses change once a write has happened, as they do in Django.
      const written = calls.some(call => call.startsWith('write:'))
      calls.push('loadSummaries')
      const reply = written ? (script.refreshed ?? AFTER) : (script.summaries ?? SUMMARIES)
      return typeof reply === 'string' ? fail(reply) : reply
    },
    async claim() {
      calls.push('claim')
      if (script.claim !== undefined) fail(script.claim)
    },
    async mintWriteToken() {
      calls.push('mint')
      if (script.mintFails !== undefined) fail(script.mintFails)
      return 'write-token'
    },
    async write(_spec, id) {
      calls.push(`write:${id}`)
      return script.writes?.[id] ?? { ok: true }
    },
  }
  return { api, calls }
}

function newStore() {
  return createConfirmStore().create('session')
}

describe('openCard', () => {
  it('loads the batch and the names, and takes the AI draft as the reason', async () => {
    const store = newStore()
    const { api } = fakeApi({})

    await openCard(api, store.actions, APPROVE, BATCH)

    expect(store.getSnapshot().cards[KEY]).toMatchObject({ phase: 'ready', pending: PENDING, summaries: SUMMARIES, reason: 'AI draft' })
  })

  it('keeps what staff typed when it reloads after a failure', async () => {
    const store = newStore()
    store.actions.editReason(KEY, 'My own words')

    await openCard(fakeApi({}).api, store.actions, APPROVE, BATCH)

    expect(store.getSnapshot().cards[KEY]).toMatchObject({ phase: 'ready', reason: 'My own words', edited: true })
  })

  it('still shows names and statuses when the batch has expired', async () => {
    const store = newStore()

    await openCard(fakeApi({ pending: 'expired' }).api, store.actions, APPROVE, BATCH)

    expect(store.getSnapshot().cards[KEY]).toMatchObject({ phase: 'expired', summaries: SUMMARIES, pending: null })
  })

  it('reports sign-in over any other failure, whichever load failed', async () => {
    const first = newStore()
    const second = newStore()

    await openCard(fakeApi({ pending: 'sign-in', summaries: 'unavailable' }).api, first.actions, APPROVE, BATCH)
    await openCard(fakeApi({ pending: 'unavailable', summaries: 'sign-in' }).api, second.actions, APPROVE, BATCH)

    expect(first.getSnapshot().cards[KEY]?.phase).toBe('sign-in')
    expect(second.getSnapshot().cards[KEY]?.phase).toBe('sign-in')
  })

  it('reports the tool service failure when the names loaded but the batch did not', async () => {
    const store = newStore()

    await openCard(fakeApi({ pending: 'refused' }).api, store.actions, APPROVE, BATCH)

    expect(store.getSnapshot().cards[KEY]?.phase).toBe('refused')
  })

  it('reports the names failure when the batch loaded but the names did not', async () => {
    const store = newStore()

    await openCard(fakeApi({ summaries: 'unavailable' }).api, store.actions, APPROVE, BATCH)

    expect(store.getSnapshot().cards[KEY]).toMatchObject({ phase: 'unavailable', summaries: [] })
  })

  it('prefers the batch’s failure when both fail for reasons other than sign-in', async () => {
    const store = newStore()

    await openCard(fakeApi({ pending: 'expired', summaries: 'unavailable' }).api, store.actions, APPROVE, BATCH)

    expect(store.getSnapshot().cards[KEY]?.phase).toBe('expired')
  })

  it('reports an unexpected error as unavailable', async () => {
    const store = newStore()
    const api: ConfirmApi = {
      ...fakeApi({}).api,
      loadPending: async () => { throw new Error('not a classified error') },
    }

    await openCard(api, store.actions, APPROVE, BATCH)

    expect(store.getSnapshot().cards[KEY]?.phase).toBe('unavailable')
  })

  it('moves back to loading while it reloads', async () => {
    const store = newStore()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const api: ConfirmApi = { ...fakeApi({}).api, loadPending: async () => { await gate; return PENDING } }

    const opening = openCard(api, store.actions, APPROVE, BATCH)
    expect(store.getSnapshot().cards[KEY]?.phase).toBe('loading')
    release()
    await opening

    expect(store.getSnapshot().cards[KEY]?.phase).toBe('ready')
  })
})

describe('confirmCard', () => {
  it('mints the token first, uses the batch up second, then writes each record', async () => {
    const store = newStore()
    const { api, calls } = fakeApi({})

    await confirmCard(api, store.actions, APPROVE, BATCH, [7, 8], '')

    expect(calls).toEqual(['mint', 'claim', 'write:7', 'write:8', 'loadSummaries'])
    expect(store.getSnapshot().cards[KEY]).toMatchObject({
      phase: 'done',
      step: null,
      summaries: AFTER,
      results: { 7: { ok: true }, 8: { ok: true } },
    })
  })

  it('passes the reason staff finalised to the token and to each write', async () => {
    const seen: string[] = []
    const { api } = fakeApi({})
    const spying: ConfirmApi = {
      ...api,
      mintWriteToken: async (_spec, _ids, reason) => { seen.push(`mint:${reason}`); return 't' },
      write: async (_spec, id, _token, reason) => { seen.push(`write:${id}:${reason}`); return { ok: true } },
    }

    await confirmCard(spying, newStore().actions, REJECT, BATCH, [7, 8], 'Passport unreadable')

    expect(seen).toEqual(['mint:Passport unreadable', 'write:7:Passport unreadable', 'write:8:Passport unreadable'])
  })

  it('records each outcome, so one refused record does not stop the others', async () => {
    const store = newStore()
    const refused: RecordOutcome = { ok: false, kind: 'rejected', detail: 'already decided' }
    const { api, calls } = fakeApi({ writes: { 7: refused } })

    await confirmCard(api, store.actions, APPROVE, BATCH, [7, 8], '')

    expect(calls).toContain('write:8')
    expect(store.getSnapshot().cards[KEY]).toMatchObject({ phase: 'done', results: { 7: refused, 8: { ok: true } } })
  })

  it.each(['sign-in', 'unavailable', 'refused'] as const)(
    'stops before using the batch up when minting fails with %s, so a retry after sign-in works',
    async (kind) => {
      const store = newStore()
      const { api, calls } = fakeApi({ mintFails: kind })

      await confirmCard(api, store.actions, APPROVE, BATCH, [7, 8], '')

      expect(calls).toEqual(['mint'])
      expect(store.getSnapshot().cards[KEY]).toMatchObject({ phase: kind, step: null, results: {} })
    },
  )

  it('does not write when the batch expired or was already used', async () => {
    const store = newStore()
    const { api, calls } = fakeApi({ claim: 'expired' })

    await confirmCard(api, store.actions, APPROVE, BATCH, [7, 8], '')

    expect(calls).toEqual(['mint', 'claim'])
    expect(store.getSnapshot().cards[KEY]?.phase).toBe('expired')
  })

  it('still finishes when the refresh of statuses fails, and keeps the outcomes', async () => {
    const store = newStore()
    const { api } = fakeApi({ refreshed: 'unavailable' })

    await confirmCard(api, store.actions, APPROVE, BATCH, [7, 8], '')

    expect(store.getSnapshot().cards[KEY]).toMatchObject({ phase: 'done', results: { 7: { ok: true }, 8: { ok: true } } })
  })

  it('reports an unexpected error as unavailable', async () => {
    const store = newStore()
    const api: ConfirmApi = { ...fakeApi({}).api, mintWriteToken: async () => { throw new Error('boom') } }

    await confirmCard(api, store.actions, APPROVE, BATCH, [7, 8], '')

    expect(store.getSnapshot().cards[KEY]?.phase).toBe('unavailable')
  })

  it('shows which step it is on while it runs', async () => {
    const store = newStore()
    const steps: (string | null | undefined)[] = []
    const api: ConfirmApi = {
      ...fakeApi({}).api,
      mintWriteToken: async () => { steps.push(store.getSnapshot().cards[KEY]?.step); return 't' },
      claim: async () => { steps.push(store.getSnapshot().cards[KEY]?.step) },
      write: async () => { steps.push(store.getSnapshot().cards[KEY]?.step); return { ok: true } },
    }

    await confirmCard(api, store.actions, APPROVE, BATCH, [7], '')

    expect(steps).toEqual(['token', 'claim', 'write'])
  })
})

describe('cancelCard', () => {
  it('uses the batch up without minting or writing', async () => {
    const store = newStore()
    const { api, calls } = fakeApi({})

    await cancelCard(api, store.actions, BATCH)

    expect(calls).toEqual(['claim'])
    expect(store.getSnapshot().cards[KEY]?.phase).toBe('cancelled')
  })

  it('explains it when the batch is already gone', async () => {
    const store = newStore()

    await cancelCard(fakeApi({ claim: 'expired' }).api, store.actions, BATCH)

    expect(store.getSnapshot().cards[KEY]?.phase).toBe('expired')
  })

  it('reports an unexpected error as unavailable', async () => {
    const store = newStore()
    const api: ConfirmApi = { ...fakeApi({}).api, claim: async () => { throw new Error('boom') } }

    await cancelCard(api, store.actions, BATCH)

    expect(store.getSnapshot().cards[KEY]?.phase).toBe('unavailable')
  })
})

describe('createConfirmStore', () => {
  it('starts empty and keeps one entry per batch', () => {
    const store = newStore()

    expect(store.getSnapshot()).toEqual({ cards: {}, lists: {} })
    store.actions.begin('a')
    store.actions.begin('b')
    store.actions.editReason('a', 'x')

    expect(Object.keys(store.getSnapshot().cards).sort()).toEqual(['a', 'b'])
    expect(store.getSnapshot().cards.a).toMatchObject({ reason: 'x', edited: true })
    expect(store.getSnapshot().cards.b).toEqual(EMPTY_CARD)
  })

  it('keeps one Session’s cards apart from another’s', () => {
    const first = createConfirmStore().create('one')
    const second = createConfirmStore().create('two')

    first.actions.begin('a')

    expect(second.getSnapshot()).toEqual({ cards: {}, lists: {} })
  })
})
