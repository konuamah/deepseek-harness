import { useEffect, useId } from 'react'
import clsx from 'clsx'
import { Button, IconWarningOutlineRegular, Input, Tag, TextShimmer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { CardData } from './card-definition.ts'
import type { ConfirmApi, RecordOutcome, Summary } from './api.ts'
import { cancelCard, confirmCard, openCard } from './controller.ts'
import { EMPTY_CARD, type CardState, type createConfirmStore } from './confirm-store.ts'
import type { AiConfirmKey } from './locales.ts'
import {
  MAX_REASON_LENGTH, parsePrepared, shownName, statusAfter, statusKey, type ActionSpec, type PreparedBatch,
} from './model.ts'
import css from './ConfirmCard.module.css'

/** What the plugin injects into every card: the network faces, the action it stands for, and the sign-in page. */
export interface ConfirmInjected {
  readonly api: ConfirmApi
  readonly spec: ActionSpec
  readonly signInUrl: string
}

/** Full props of a registered confirm card. */
export type ConfirmCardProps = CardData
  & PropsStore<ReturnType<typeof createConfirmStore>>
  & InjectFace<ConfirmInjected>
  & PropsLocale<'aiConfirm'>

export type Translate = ConfirmCardProps['t']

const TITLES = {
  approve: ['title.approve.one', 'title.approve.other'],
  reject: ['title.reject.one', 'title.reject.other'],
  requestDocuments: ['title.requestDocuments.one', 'title.requestDocuments.other'],
  cancel: ['title.cancel.one', 'title.cancel.other'],
  verifyDocument: ['title.verifyDocument.one', 'title.verifyDocument.other'],
  rejectDocument: ['title.rejectDocument.one', 'title.rejectDocument.other'],
  enroll: ['title.enroll.one', 'title.enroll.other'],
  sendOffer: ['title.sendOffer.one', 'title.sendOffer.other'],
} as const satisfies Record<ActionSpec['copy'], readonly [AiConfirmKey, AiConfirmKey]>

/** Consequences staff must see before confirming. */
const WARNINGS: Partial<Record<ActionSpec['copy'], AiConfirmKey>> = {
  approve: 'warning.approve',
  requestDocuments: 'warning.requestDocuments',
  cancel: 'warning.cancel',
  verifyDocument: 'warning.verifyDocument',
  rejectDocument: 'warning.rejectDocument',
  enroll: 'warning.enroll',
  sendOffer: 'warning.sendOffer',
}

export function statusLabel(t: Translate, status: string): string {
  const key = statusKey(status)
  return key === undefined ? status : t(key)
}

/**
 * Render one prepare tool call: a plain row while it runs or when it failed, and the confirm card
 * once it returns a batch.
 * @param props - logged card data, the card store, the injected faces and the locale seat.
 * @returns the card.
 */
export function ConfirmCard(props: ConfirmCardProps) {
  const { t } = props
  if (props.phase !== 'result') {
    const label = t('call.running')
    return (
      <div className={css.card} data-tool="ai-confirm" data-state="running">
        <TextShimmer active className={css.status}>{label}</TextShimmer>
      </div>
    )
  }
  const text = props.text
  const batch = props.isError ? null : parsePrepared(text)
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
  const reference = ids.length === 1 ? card.summaries.find(summary => summary.id === ids[0])?.reference : undefined
  const referenceMissing = spec.confirmReference === true
    && (!reference || card.confirmReference !== reference || batch.eligible.length !== 1)
  return {
    reference,
    referenceMissing,
    busy,
    editable: card.phase === 'ready' || busy,
    reason,
    reasonMissing: spec.reason === 'required' && reason === '',
    ids,
    total: ids.length,
  }
}

/** Whether every record in a closed batch now holds the status the batch asked for. */
function closedMatches(card: CardState, spec: ActionSpec, batch: PreparedBatch): boolean {
  const requested = statusAfter(spec.action)
  return card.phase === 'expired' && requested !== undefined
    && batch.eligible.every(record => card.summaries.some(summary => summary.id === record.id && summary.status === requested))
}

function BatchCard({ batch, spec, api, signInUrl, t, useStore, actions }: BatchCardProps) {
  const key = batch.pendingActionId
  const titleId = useId()
  const stored = useStore(state => state.cards[key])
  const card = stored ?? EMPTY_CARD
  const opened = stored !== undefined
  useEffect(() => {
    // The card loads its batch once; a remount while loading or after finishing finds the stored state.
    if (!opened) void openCard(api, actions, spec, batch)
  }, [opened, api, actions, spec, batch])

  const view = viewOf(card, spec, batch)
  const [one, other] = TITLES[spec.copy]
  const warning = WARNINGS[spec.copy]
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
            api={api}
            resource={spec.resource}
            fallbackStatus={record.status}
            summary={card.summaries.find(summary => summary.id === record.id)}
            after={statusAfter(spec.action)}
            phase={card.phase}
            outcome={card.results[record.id]}
          />
        ))}
      </ul>
      {batch.skipped.length > 0 && <SkippedList t={t} batch={batch} resource={spec.resource} />}
      {warning !== undefined && view.editable && <p className={css.warning} role="note">{t(warning)}</p>}
      {spec.reason !== 'none' && view.editable && (
        <ReasonField
          t={t}
          label={spec.copy === 'enroll' ? 'reason.enrollLabel' : 'reason.label'}
          value={card.reason}
          disabled={view.busy}
          missing={view.reasonMissing}
          onChange={(reason) => { actions.editReason(key, reason) }}
        />
      )}
      {spec.confirmReference && view.editable && (
        <ReferenceField
          t={t}
          reference={view.reference}
          value={card.confirmReference}
          disabled={view.busy}
          onChange={(reference) => { actions.editReference(key, reference) }}
        />
      )}
      <Banner
        t={t}
        card={card}
        total={view.total}
        closedMatches={closedMatches(card, spec, batch)}
        signInUrl={signInUrl}
        onRetry={() => { void openCard(api, actions, spec, batch) }}
      />
      {view.editable && (
        <Actions
          t={t}
          busy={view.busy}
          confirmDisabled={view.reasonMissing || view.referenceMissing}
          onCancel={() => { void cancelCard(api, actions, batch) }}
          onConfirm={() => {
            if (view.busy || view.reasonMissing || view.referenceMissing) return
            void confirmCard(api, actions, spec, batch, view.ids, spec.reason === 'none' ? '' : view.reason, card.confirmReference)
          }}
        />
      )}
    </section>
  )
}

interface ReferenceFieldProps {
  readonly t: Translate
  readonly reference: string | undefined
  readonly value: string
  readonly disabled: boolean
  readonly onChange: (reference: string) => void
}

function ReferenceField({ t, reference, value, disabled, onChange }: ReferenceFieldProps) {
  const hintId = useId()
  return (
    <div className={css.reason}>
      <label className={css.reasonLabel}>
        <span>{t('reference.label')}</span>
        <Input
          className={clsx(css.referenceInput)}
          value={value}
          maxLength={32}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled || !reference}
          aria-describedby={hintId}
          aria-invalid={value !== '' && value !== reference}
          onChange={(event) => { onChange(event.target.value) }}
        />
      </label>
      <span id={hintId}>{reference ? t('reference.hint', { reference }) : t('reference.unavailable')}</span>
    </div>
  )
}

interface ReasonFieldProps {
  readonly t: Translate
  readonly label: AiConfirmKey
  readonly value: string
  readonly disabled: boolean
  readonly missing: boolean
  readonly onChange: (reason: string) => void
}

/** The editable reason. The error sits outside the label so it does not become part of the field's name. */
function ReasonField({ t, label, value, disabled, missing, onChange }: ReasonFieldProps) {
  const errorId = useId()
  return (
    <div className={css.reason}>
      <label className={css.reasonLabel}>
        <span>{t(label)}</span>
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
  readonly api: ConfirmApi
  readonly resource: ActionSpec['resource']
  readonly fallbackStatus: string
  readonly summary: Summary | undefined
  readonly after: string | undefined
  readonly phase: CardState['phase']
  readonly outcome: RecordOutcome | undefined
}

function RecordRow({ t, id, api, resource, fallbackStatus, summary, after, phase, outcome }: RecordRowProps) {
  const current = summary?.status ?? fallbackStatus
  const pending = (phase === 'ready' || phase === 'confirming') && outcome === undefined
  const meta = summary === undefined ? '' : `${summary.reference} · ${'documentType' in summary ? summary.documentType : summary.program.code}`
  const name = summary === undefined ? t(UNNAMED[resource], { id }) : (shownName(summary.name) ?? '—')
  return (
    <li className={css.record}>
      <span className={css.name}>{name}</span>
      {meta !== '' && <span className={css.meta}>{meta}</span>}
      {summary !== undefined && 'documentType' in summary && (
        <span className={css.fileLinks}>
          {summary.previewable && <a href={api.documentUrl('uploaded', summary.id, 'view')} target="_blank" rel="noopener noreferrer">{t('files.view')}</a>}
          <a href={api.documentUrl('uploaded', summary.id, 'download')} target="_blank" rel="noopener noreferrer">{t('files.download')}</a>
        </span>
      )}
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

const UNNAMED = { application: 'record.unnamed', document: 'record.unnamedDocument' } as const

function SkippedList({ t, batch, resource }: { readonly t: Translate; readonly batch: PreparedBatch; readonly resource: ActionSpec['resource'] }) {
  return (
    <div className={css.skipped}>
      <p className={css.skippedTitle}>{t('skipped.title')}</p>
      <ul>
        {batch.skipped.map(record => (
          <li key={record.id} className={css.skippedRow}>
            <span>{t(UNNAMED[resource], { id: record.id })}</span>
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
  readonly closedMatches: boolean
  readonly signInUrl: string
  readonly onRetry: () => void
}

/** The one status message for the card's phase, announced politely to assistive technology. */
function Banner({ t, card, total, closedMatches, signInUrl, onRetry }: BannerProps) {
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
    expired: closedMatches ? `${t('state.expired')} ${t('state.closedMatches')}` : t('state.expired'),
    refused: t('state.refused'),
    unavailable: t('state.unavailable'),
    cancelled: t('state.cancelled'),
  }[phase]
  // A closed request is not a failure: keep the calm secondary style, without the failure divider.
  const failed = phase !== 'expired' && phase !== 'cancelled'
  return (
    <div role={failed ? 'alert' : 'status'} className={css.banner} data-failure={failed ? phase : undefined}>
      {failed && <span className={css.bannerIcon} aria-hidden="true"><IconWarningOutlineRegular /></span>}
      <span>{message}</span>
      {phase === 'sign-in' && (
        <a href={signInUrl} target="_blank" rel="noopener noreferrer" className={css.link}>{t('action.signIn')}</a>
      )}
      {retryable && <Button variant="outline" size="sm" onClick={onRetry}>{t('action.retry')}</Button>}
    </div>
  )
}
