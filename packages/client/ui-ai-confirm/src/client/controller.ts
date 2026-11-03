/**
 * The confirm flow as plain functions over the network faces and the store: open a card, confirm
 * it, cancel it. No UI and no Session objects, so the whole flow is testable without rendering.
 *
 * Confirm order matters. The write token is minted first, so a signed-out or 2FA-incomplete session
 * fails before the batch is used up and the card can simply retry after sign-in. The batch is used
 * up second, so a batch that expired or was already used never writes. Writes run last, one record
 * at a time, each with its own outcome.
 */
import { ConfirmApiError, type ConfirmApi, type FailureKind } from './api.ts'
import type { CardSink } from './confirm-store.ts'
import type { ActionSpec, PreparedBatch } from './model.ts'

function kindOf(error: unknown): FailureKind {
  return error instanceof ConfirmApiError ? error.kind : 'unavailable'
}

/**
 * The most useful failure among settled loads: a sign-in problem explains the others, and otherwise
 * the first load's failure wins because the batch says more than the names do.
 */
function failureOf(results: readonly PromiseSettledResult<unknown>[]): FailureKind {
  const kinds = results.flatMap(result => (result.status === 'rejected' ? [kindOf(result.reason)] : []))
  return kinds.includes('sign-in') ? 'sign-in' : kinds.reduceRight<FailureKind>((_, kind) => kind, 'unavailable')
}

/**
 * Load a batch and the names of its records. Safe to call again after a failure (for example
 * after sign-in): it reloads and keeps what staff have typed.
 * @param api - the network faces.
 * @param sink - the store's state changes.
 * @param batch - the prepare tool's result; its id is the card's key and its records are the ones to name.
 * @returns once the card is in a settled phase.
 */
export async function openCard(api: ConfirmApi, sink: CardSink, batch: PreparedBatch): Promise<void> {
  const key = batch.pendingActionId
  sink.begin(key)
  const [pending, summaries] = await Promise.allSettled([
    api.loadPending(key),
    api.loadSummaries(batch.eligible.map(record => record.id)),
  ])
  if (pending.status === 'fulfilled' && summaries.status === 'fulfilled') {
    sink.loaded(key, pending.value, summaries.value)
    return
  }
  // Names and current statuses are still worth showing when only the batch is gone (expired or used).
  if (summaries.status === 'fulfilled') sink.summaries(key, summaries.value)
  sink.failed(key, failureOf([pending, summaries]))
}

/**
 * Run the confirm: mint the write token, use the batch up, write each record.
 * @param api - the network faces.
 * @param sink - the store's state changes.
 * @param spec - the action being confirmed.
 * @param batch - the prepare tool's result.
 * @param ids - the records the tool service holds for this batch.
 * @param reason - the reason as staff finalised it; empty when the action takes none.
 * @returns once the card is `done` or has stopped on a failure it explains.
 */
export async function confirmCard(
  api: ConfirmApi,
  sink: CardSink,
  spec: ActionSpec,
  batch: PreparedBatch,
  ids: readonly number[],
  reason: string,
): Promise<void> {
  const key = batch.pendingActionId
  try {
    sink.confirming(key, 'token')
    const token = await api.mintWriteToken(spec, ids, reason)
    sink.confirming(key, 'claim')
    await api.claim(key)
    sink.confirming(key, 'write')
    for (const id of ids) sink.recorded(key, id, await api.write(spec, id, token, reason))
  } catch (error) {
    sink.failed(key, kindOf(error))
    return
  }
  try {
    // Show the statuses Django now holds; a failure here must not hide the outcomes already recorded.
    sink.summaries(key, await api.loadSummaries(ids))
  } catch {
    // The per-record outcomes already tell staff what happened.
  }
  sink.finished(key)
}

/**
 * Use the batch up without writing, so it cannot run later.
 * @param api - the network faces.
 * @param sink - the store's state changes.
 * @param batch - the prepare tool's result.
 * @returns once the card is `cancelled` or has stopped on a failure it explains.
 */
export async function cancelCard(api: ConfirmApi, sink: CardSink, batch: PreparedBatch): Promise<void> {
  const key = batch.pendingActionId
  try {
    await api.claim(key)
    sink.cancelled(key)
  } catch (error) {
    sink.failed(key, kindOf(error))
  }
}
