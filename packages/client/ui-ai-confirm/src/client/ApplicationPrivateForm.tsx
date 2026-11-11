/** Private application create and document-upload form. */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  formFailure, type ApplicationCatalog, type ApplicationFormApi, type UploadTarget,
} from './application-form-api.ts'
import { APPLICATION_FIELDS, applicationBody } from './application-fields.ts'
import { ApplicationFields } from './ApplicationFields.tsx'
import { Choice, DiscardPrompt, Documents } from './FormParts.tsx'
import type { FormCommonProps } from './form-types.ts'
import { statusKey } from './model.ts'
import css from './PrivateForm.module.css'

/**
 * Render application create or upload. Submitting is the only write; the form never autosubmits.
 * @param props - loaded catalog/target, private API and shared form state.
 * @returns the application form.
 */
export function ApplicationPrivateForm(props: {
  readonly mode: 'create' | 'upload'
  readonly applicationId: number | null
  readonly catalog: ApplicationCatalog
  readonly target: UploadTarget | null
  readonly applicationApi: ApplicationFormApi
  readonly targetKey: string
  readonly common: FormCommonProps
}) {
  const { mode, applicationId, catalog, target, applicationApi, targetKey, common } = props
  const { callId, state, locked, actions, t } = common
  const [files, setFiles] = useState<Readonly<Record<number, File>>>({})
  const [uploaded, setUploaded] = useState<readonly string[]>([])
  const [program, setProgram] = useState('')
  const [intake, setIntake] = useState('')
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [invalid, setInvalid] = useState(false)
  const inFlight = useRef(false)

  const dirty = useMemo(
    () => Object.values(state.values).some(value => value.trim() !== '') || state.terms || Object.keys(files).length > 0,
    [state.values, state.terms, files],
  )

  useEffect(() => {
    if (!dirty || state.phase === 'saved') return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => { window.removeEventListener('beforeunload', warn) }
  }, [dirty, state.phase])

  const chooseFiles = (documentType: number, chosen: FileList | null) => {
    const file = chosen?.[0]
    setFiles((current) => {
      const next: Record<number, File> = {}
      for (const [id, value] of Object.entries(current)) {
        if (Number(id) !== documentType) next[Number(id)] = value
      }
      if (file !== undefined) next[documentType] = file
      actions.formDocuments(callId, Object.keys(next).map(Number))
      return next
    })
  }

  const begin = (): boolean => {
    if (locked || inFlight.current) return false
    inFlight.current = true
    actions.lockTarget(targetKey)
    actions.formSaving(callId)
    return true
  }

  const settle = (kind: 'sign-in' | 'invalid' | 'unavailable' | 'unknown') => {
    if (kind !== 'unknown') {
      actions.unlockTarget(targetKey)
      inFlight.current = false
    }
  }

  const submit = async () => {
    if (mode === 'create' && (
      !state.terms || program === '' || (catalog.intakes.length > 0 && intake === '')
      || APPLICATION_FIELDS.some(field => field.required && (state.values[field.name] ?? '').trim() === '')
    )) {
      setInvalid(true)
      return
    }
    if (!begin()) return
    setInvalid(false)
    try {
      if (mode === 'create') {
        const body = applicationBody(state.values, program, intake, state.terms)
        for (const [documentType, file] of Object.entries(files)) body.append(`document_${documentType}`, file)
        const created = await applicationApi.create(body)
        setFiles({})
        actions.formSaved(callId, { reference: created.reference, createdNew: created.createdNew })
      } else if (applicationId !== null) {
        const body = new FormData()
        for (const [documentType, file] of Object.entries(files)) body.append(`document_${documentType}`, file)
        await applicationApi.upload(applicationId, body)
        setUploaded(current => [
          ...current,
          ...catalog.documents.filter(choice => files[choice.id] !== undefined).map(choice => choice.name),
        ])
        setFiles({})
        actions.formSaved(callId, { reference: target?.reference })
      }
      actions.unlockTarget(targetKey)
      inFlight.current = false
    } catch (error) {
      const kind = formFailure(error)
      actions.formFailed(callId, kind)
      settle(kind)
    }
  }

  const discard = () => {
    setFiles({})
    setConfirmDiscard(false)
    setInvalid(false)
    setProgram('')
    setIntake('')
    actions.formReset(callId, {}, [])
    actions.formTerms(callId, false)
    actions.formDocuments(callId, [])
  }

  const attachedNames = catalog.documents
    .filter(choice => (target?.attachedDocumentTypeIds ?? []).includes(choice.id))
    .map(choice => choice.name)
  const choices = mode === 'upload'
    ? catalog.documents.filter(choice => !(target?.attachedDocumentTypeIds ?? []).includes(choice.id))
    : catalog.documents
  const statusKeyForTarget = target === null ? undefined : statusKey(target.status)
  const status = target === null ? '' : statusKeyForTarget === undefined ? target.status : t(statusKeyForTarget)

  return <div className={css.form}>
    {target !== null && <p className={css.hint}>{t('form.application.target', { reference: target.reference, status })}</p>}
    {invalid && <p className={css.notice} role="alert">{t('form.error.invalid')}</p>}

    {mode === 'create' && <>
      <ApplicationFields values={state.values} disabled={locked} t={t}
        onChange={(name, value) => { actions.formEdit(callId, name, value) }} />
      <Choice label={t('form.application.program')} value={program} onChange={setProgram} disabled={locked}
        choices={catalog.programs} choose={t('form.application.choose')} />
      <Choice label={t('form.application.intake')} value={intake} onChange={setIntake} disabled={locked}
        choices={catalog.intakes} choose={t('form.application.choose')} />
    </>}
    <Documents title={t('form.application.documents')} choices={choices} attachedNames={[...attachedNames, ...uploaded]}
      files={files} disabled={locked} onChoose={chooseFiles} t={t} />
    {mode === 'create' && <label className={css.field}>
      <span><input type="checkbox" checked={state.terms} disabled={locked}
        onChange={(event) => { actions.formTerms(callId, event.currentTarget.checked) }} /> {t('form.application.terms')}</span>
    </label>}

    {state.phase === 'saved' && mode === 'create' && state.reference !== null && (
      <p className={css.notice} role="status">
        {t(state.createdNew === false ? 'form.application.duplicate' : 'form.application.created', { reference: state.reference })}
      </p>
    )}
    {state.phase === 'saved' && mode === 'upload' && (
      <p className={css.notice} role="status">{t('form.application.uploaded')}</p>
    )}
    {confirmDiscard && <DiscardPrompt onKeep={() => { setConfirmDiscard(false) }} onDiscard={discard} t={t} />}

    <div className={css.actions}>
      <Button size="sm" disabled={locked || state.phase === 'saved'
        || (mode === 'upload' && Object.keys(files).length === 0)} onClick={() => { void submit() }}>
        {state.phase === 'saving' ? t('form.saving')
          : t(mode === 'create' ? 'form.application.submit' : 'form.application.uploadSubmit')}
      </Button>
      {dirty && state.phase !== 'saved' && !confirmDiscard
        && <Button size="sm" variant="ghost" disabled={locked} onClick={() => { setConfirmDiscard(true) }}>{t('form.action.cancel')}</Button>}
    </div>
  </div>
}
