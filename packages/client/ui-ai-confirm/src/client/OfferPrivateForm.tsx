/** Private draft-offer create and edit form; saving never sends the offer. */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { formFailure, type ApplicationCatalog, type UploadTarget } from './application-form-api.ts'
import { DiscardPrompt, OfferFields, Scholarships, Totals } from './FormParts.tsx'
import type { FormCommonProps } from './form-types.ts'
import { draftValues, offerBody } from './offer-fields.ts'
import type { OfferDraft, OfferFormApi } from './offer-form-api.ts'
import css from './PrivateForm.module.css'

/**
 * Render the draft offer form. A missing draft stays unsaved until staff click Save.
 * @param props - loaded draft/catalog, private API and shared form state.
 * @returns the offer form.
 */
export function OfferPrivateForm(props: {
  readonly applicationId: number
  readonly catalog: ApplicationCatalog
  readonly draft: OfferDraft | null
  readonly target: UploadTarget | null
  readonly offerApi: OfferFormApi
  readonly targetKey: string
  readonly onSaved: (draft: OfferDraft) => void
  readonly common: FormCommonProps
}) {
  const { applicationId, catalog, draft, target, offerApi, targetKey, onSaved, common } = props
  const { callId, state, locked, actions, t } = common
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [noChanges, setNoChanges] = useState(false)
  const inFlight = useRef(false)

  const baselineValues = useMemo(() => draftValues(draft), [draft])
  const baselineScholarships = draft?.offer_scholarships ?? []
  const dirty = useMemo(
    () => JSON.stringify(state.values) !== JSON.stringify(baselineValues)
      || JSON.stringify(state.scholarships) !== JSON.stringify(baselineScholarships),
    [state.values, state.scholarships, baselineValues, baselineScholarships],
  )
  // The preview reads the saved draft, so it stays unavailable while entries differ or a save is unsettled.
  const canPreview = draft !== null && !dirty && !locked
  const previewUrl = offerApi.previewUrl(applicationId)

  useEffect(() => {
    if (!dirty || state.phase === 'saved') return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => { window.removeEventListener('beforeunload', warn) }
  }, [dirty, state.phase])

  const submit = async () => {
    if (locked || inFlight.current) return
    const body = offerBody(state.values, state.scholarships, draft === null ? null : baselineValues, baselineScholarships)
    if (Object.keys(body).length === 0) {
      setNoChanges(true)
      return
    }
    inFlight.current = true
    actions.lockTarget(targetKey)
    actions.formSaving(callId)
    setNoChanges(false)
    try {
      const saved = await offerApi.save(applicationId, body, draft === null)
      onSaved(saved)
      actions.formReady(callId, draftValues(saved), saved.offer_scholarships)
      actions.formSaved(callId, {
        reference: target?.reference,
        totals: {
          totalFees: saved.total_fees,
          totalScholarships: saved.total_scholarships,
          netFeePayable: saved.net_fee_payable,
        },
      })
      actions.unlockTarget(targetKey)
      inFlight.current = false
    } catch (error) {
      const kind = formFailure(error)
      actions.formFailed(callId, kind)
      if (kind !== 'unknown') {
        actions.unlockTarget(targetKey)
        inFlight.current = false
      }
    }
  }

  const discard = () => {
    setConfirmDiscard(false)
    actions.formReset(callId, baselineValues, baselineScholarships)
  }

  const totals = state.totals ?? (draft === null ? null : {
    totalFees: draft.total_fees, totalScholarships: draft.total_scholarships, netFeePayable: draft.net_fee_payable,
  })

  return <div className={css.form}>
    {target !== null && <p className={css.hint}>{t('form.offer.reference', { reference: target.reference })}</p>}
    {noChanges && <p className={css.notice} role="status">{t('form.offer.noChanges')}</p>}

    <OfferFields values={state.values} onChange={(name, value) => { actions.formEdit(callId, name, value) }} disabled={locked} t={t} />
    <Scholarships scholarships={state.scholarships} choices={catalog.scholarships} disabled={locked}
      onChange={(lines) => { actions.formScholarships(callId, lines) }} t={t} />
    <p className={css.hint}>{t('form.offer.sendingNote')}</p>
    {state.phase === 'saved' && <p className={css.notice} role="status">{t('form.offer.saved')}</p>}
    {totals !== null && <Totals totals={totals} currency={draft?.currency ?? ''} t={t} />}
    {confirmDiscard && <DiscardPrompt onKeep={() => { setConfirmDiscard(false) }} onDiscard={discard} t={t} />}

    <div className={css.actions}>
      <Button size="sm" disabled={locked} onClick={() => { void submit() }}>
        {state.phase === 'saving' ? t('form.saving') : t('form.offer.save')}
      </Button>
      {draft !== null && (canPreview
        ? <a className={css.actionLink} href={previewUrl} target="_blank" rel="noopener noreferrer">{t('form.offer.preview')}</a>
        : <span className={css.hint}>{t('form.offer.previewSaveFirst')}</span>)}
      {dirty && !confirmDiscard
        && <Button size="sm" variant="ghost" disabled={locked} onClick={() => { setConfirmDiscard(true) }}>{t('form.action.cancel')}</Button>}
    </div>
  </div>
}
