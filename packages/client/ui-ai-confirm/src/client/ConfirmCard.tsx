import { useEffect, useId } from 'react'
import { Button, Tag, TextShimmer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { ApplicationSummary, ConfirmApi, RecordOutcome } from './api.ts'
import { cancelCard, confirmCard, openCard } from './controller.ts'
import { EMPTY_CARD, type CardState, type createConfirmStore } from './confirm-store.ts'
import type { AiConfirmKey } from './locales.ts'
import {
  MAX_REASON_LENGTH, parsePrepared, statusAfter, statusKey, type ActionSpec, type PreparedBatch,
} from './model.ts'
import css from './ConfirmCard.module.css'

/** What the plugin injects into every card: the network faces, the action it stands for, and the sign-in page. */
export interface ConfirmInjected {
  readonly api: ConfirmApi
  readonly spec: ActionSpec
  readonly signInUrl: string
}

/** Full props of a registered confirm card. */
export type ConfirmCardProps = ToolCallViewProps
  & PropsStore<ReturnType<typeof createConfirmStore>>
  & InjectFace<ConfirmInjected>
  & PropsLocale<'aiConfirm'>

type Translate = ConfirmCardProps['t']

const TITLES = {
  approve: ['title.approve.one', 'title.approve.other'],
  reject: ['title.reject.one', 'title.reject.other'],
  requestDocuments: ['title.requestDocuments.one', 'title.requestDocuments.other'],
} as const satisfies Record<ActionSpec['copy'], readonly [AiConfirmKey, AiConfirmKey]>

/** The result's text parts joined; a non-text part carries nothing this card reads. */
function resultText(block: Extract<ConfirmCardProps, { phase: 'result' }>['block']): string {
  return block.content.flatMap(part => (part.type === 'text' ? [part.text] : [])).join('\n')
}

function statusLabel(t: Translate, status: string): string {
  const key = statusKey(status)
  return key === undefined ? status : t(key)
}

/**
 * Render one prepare tool call: a plain row while it runs or when it failed, and the confirm card
 * once it returns a batch.
 * @param props - keyed toolview payload, the card store, the injected faces and the locale seat.
 * @returns the card.
 */
export function ConfirmCard(props: ConfirmCardProps) {
  const { t } = props
  if (props.phase !== 'result') {
    const label = props.phase === 'preparing' ? t('call.preparing') : t('call.running')
    return (
      <div className={css.card} data-tool="ai-confirm" data-state="running">
        <TextShimmer active className={css.status}>{label}</TextShimmer>
      </div>
    )
  }
  const text = resultText(props.block)
  const batch = props.block.isError ? null : parsePrepared(text)
  if (batch === null) {
    return (
      <div className={css.card} data-tool="ai-confirm" data-state="failed">
        <p className={css.error}>{t('call.failed')}</p>
        {text !== '' && <p className={css.detail}>{text}</p>}
      </div>
    )
  }
  return <BatchCard {...props} batch={batch} />
}

type BatchCardProps = ConfirmCardProps & { readonly batch: PreparedBatch }

/** What the card derives from its stored state to decide what to show and what a click may do. */
function viewOf(card: CardState, spec: ActionSpec, batch: PreparedBatch) {
  const busy = card.phase === 'confirming'
  const reason = card.reason.trim()
  const ids = card.pending?.ids ?? batch.eligible.map(record => record.id)
  return {
    busy,
    editable: card.phase === 'ready' || busy,
    reason,
    reasonMissing: spec.reason === 'required' && reason === '',
    ids,
    total: ids.length,
  }
}

function BatchCard({ batch, spec, api, signInUrl, t, useStore, actions }: BatchCardProps) {
  const key = batch.pendingActionId
  const titleId = useId()
  const stored = useStore(state => state.cards[key])
  const card = stored ?? EMPTY_CARD
  const opened = stored !== undefined
  useEffect(() => {
    // The card loads its batch once; a remount while loading or after finishing finds the stored state.
    if (!opened) void openCard(api, actions, batch)
  }, [opened, api, actions, batch])

  const view = viewOf(card, spec, batch)
  const [one, other] = TITLES[spec.copy]
  return (
    <section className={css.card} data-tool="ai-confirm" data-state={card.phase} aria-labelledby={titleId}>
      <h3 id={titleId} className={css.title}>
        {t(batch.eligible.length === 1 ? one : other, { count: batch.eligible.length })}
      </h3>
      <ul className={css.records} aria-label={t('records.label')}>
        {batch.eligible.map(record => (
          <RecordRow
            key={record.id}
            t={t}
            id={record.id}
            fallbackStatus={record.status}
            summary={card.summaries.find(summary => summary.id === record.id)}
            after={statusAfter(spec.action)}
            phase={card.phase}
            outcome={card.results[record.id]}
          />
        ))}
      </ul>
      {batch.skipped.length > 0 && <SkippedList t={t} batch={batch} />}
      {spec.reason !== 'none' && view.editable && (
        <ReasonField
          t={t}
          value={card.reason}
          disabled={view.busy}
          missing={view.reasonMissing}
          onChange={(reason) => { actions.editReason(key, reason) }}
        />
      )}
      <Banner
        t={t}
        card={card}
        total={view.total}
        signInUrl={signInUrl}
        onRetry={() => { void openCard(api, actions, batch) }}
      />
      {view.editable && (
        <Actions
          t={t}
          busy={view.busy}
          confirmDisabled={view.reasonMissing}
          onCancel={() => { void cancelCard(api, actions, batch) }}
          onConfirm={() => {
            void confirmCard(api, actions, spec, batch, view.ids, spec.reason === 'none' ? '' : view.reason)
          }}
        />
      )}
    </section>
  )
}

interface ReasonFieldProps {
  readonly t: Translate
  readonly value: string
  readonly disabled: boolean
  readonly missing: boolean
  readonly onChange: (reason: string) => void
}

/** The editable reason. The error sits outside the label so it does not become part of the field's name. */
function ReasonField({ t, value, disabled, missing, onChange }: ReasonFieldProps) {
  const errorId = useId()
  return (
    <div className={css.reason}>
      <label className={css.reasonLabel}>
        <span>{t('reason.label')}</span>
        <textarea
          value={value}
          maxLength={MAX_REASON_LENGTH}
          disabled={disabled}
          aria-invalid={missing}
          aria-describedby={missing ? errorId : undefined}
          onChange={(event) => { onChange(event.target.value) }}
        />
      </label>
      {missing && <span id={errorId} className={css.error}>{t('reason.required')}</span>}
    </div>
  )
}

interface ActionsProps {
  readonly t: Translate
  readonly busy: boolean
  readonly confirmDisabled: boolean
  readonly onCancel: () => void
  readonly onConfirm: () => void
}

function Actions({ t, busy, confirmDisabled, onCancel, onConfirm }: ActionsProps) {
  return (
    <div className={css.actions}>
      <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>{t('action.cancel')}</Button>
      <Button variant="primary" size="sm" disabled={busy || confirmDisabled} onClick={onConfirm}>
        {t('action.confirm')}
      </Button>
    </div>
  )
}

interface RecordRowProps {
  readonly t: Translate
  readonly id: number
  readonly fallbackStatus: string
  readonly summary: ApplicationSummary | undefined
  readonly after: string | undefined
  readonly phase: CardState['phase']
  readonly outcome: RecordOutcome | undefined
}

function RecordRow({ t, id, fallbackStatus, summary, after, phase, outcome }: RecordRowProps) {
  const current = summary?.status ?? fallbackStatus
  const pending = (phase === 'ready' || phase === 'confirming') && outcome === undefined
  const meta = summary === undefined ? '' : `${summary.reference} · ${summary.program.code}`
  return (
    <li className={css.record}>
      <span className={css.name}>{summary?.name ?? t('record.unnamed', { id })}</span>
      {meta !== '' && <span className={css.meta}>{meta}</span>}
      <span className={css.status}>
        {pending && after !== undefined
          ? t('change', { from: statusLabel(t, current), to: statusLabel(t, after) })
          : statusLabel(t, current)}
      </span>
      {outcome !== undefined && <OutcomeTag t={t} outcome={outcome} />}
    </li>
  )
}

function OutcomeTag({ t, outcome }: { readonly t: Translate; readonly outcome: RecordOutcome }) {
  if (outcome.ok) return <Tag tone="success">{t('result.ok')}</Tag>
  switch (outcome.kind) {
    case 'rejected':
      return <Tag tone="danger">{outcome.detail === '' ? t('result.rejectedBare') : t('result.rejected', { detail: outcome.detail })}</Tag>
    case 'refused':
      return <Tag tone="danger">{t('result.refused')}</Tag>
    case 'missing':
      return <Tag tone="warning">{t('result.missing')}</Tag>
    case 'unavailable':
      return <Tag tone="warning">{t('result.unavailable')}</Tag>
  }
}

function SkippedList({ t, batch }: { readonly t: Translate; readonly batch: PreparedBatch }) {
  return (
    <div className={css.skipped}>
      <p className={css.skippedTitle}>{t('skipped.title')}</p>
      <ul>
        {batch.skipped.map(record => (
          <li key={record.id} className={css.skippedRow}>
            <span>{t('record.unnamed', { id: record.id })}</span>
            {record.status !== null && <Tag tone="neutral">{statusLabel(t, record.status)}</Tag>}
            <span className={css.detail}>{record.why}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

interface BannerProps {
  readonly t: Translate
  readonly card: CardState
  readonly total: number
  readonly signInUrl: string
  readonly onRetry: () => void
}

/** The one status message for the card's phase, announced politely to assistive technology. */
function Banner({ t, card, total, signInUrl, onRetry }: BannerProps) {
  const { phase } = card
  if (phase === 'ready') return null
  if (phase === 'loading') {
    return <div role="status" className={css.banner}><TextShimmer active>{t('loading')}</TextShimmer></div>
  }
  if (phase === 'confirming') {
    const done = Object.keys(card.results).length
    const text = card.step === 'write' ? t('step.write', { done, total }) : t(card.step === 'claim' ? 'step.claim' : 'step.token')
    return <div role="status" className={css.banner}><TextShimmer active>{text}</TextShimmer></div>
  }
  if (phase === 'done') {
    const ok = Object.values(card.results).filter(outcome => outcome.ok).length
    return <div role="status" className={css.banner}>{t('state.done', { ok, total })}</div>
  }
  const retryable = phase === 'sign-in' || phase === 'unavailable'
  const message = {
    'sign-in': t('state.signIn'),
    expired: t('state.expired'),
    refused: t('state.refused'),
    unavailable: t('state.unavailable'),
    cancelled: t('state.cancelled'),
  }[phase]
  return (
    <div role="status" className={css.banner} data-failure={phase === 'cancelled' ? undefined : phase}>
      <span>{message}</span>
      {phase === 'sign-in' && (
        <a href={signInUrl} target="_blank" rel="noopener noreferrer" className={css.link}>{t('action.signIn')}</a>
      )}
      {retryable && <Button variant="outline" size="sm" onClick={onRetry}>{t('action.retry')}</Button>}
    </div>
  )
}
