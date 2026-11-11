/** Host for the private staff forms: load privately, then render the matching form. */
import { useEffect, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  ApplicationFormError, formFailure, type ApplicationCatalog, type ApplicationFormApi, type DocumentChoice,
  type FormChoice, type UploadTarget,
} from './application-form-api.ts'
import { ApplicationPrivateForm } from './ApplicationPrivateForm.tsx'
import { FORM_ERROR_KEYS, type FormCommonProps } from './form-types.ts'
import type { FormMarker } from './model.ts'
import { OfferPrivateForm } from './OfferPrivateForm.tsx'
import { draftValues } from './offer-fields.ts'
import type { OfferDraft, OfferFormApi } from './offer-form-api.ts'
import css from './PrivateForm.module.css'

const MAX_CATALOG_PAGES = 20

async function loadCatalog(api: ApplicationFormApi): Promise<ApplicationCatalog> {
  const all: {
    programs: FormChoice[]
    intakes: FormChoice[]
    scholarships: FormChoice[]
    documents: DocumentChoice[]
  } = { programs: [], intakes: [], scholarships: [], documents: [] }
  for (let page = 1; page <= MAX_CATALOG_PAGES; page += 1) {
    const next = await api.catalog(page)
    all.programs.push(...next.programs)
    all.intakes.push(...next.intakes)
    all.scholarships.push(...next.scholarships)
    all.documents.push(...next.documents)
    if (!next.hasMore) return { page: 1, hasMore: false, ...all }
  }
  throw new ApplicationFormError('unavailable')
}

/**
 * Load one form's private choices and target, then render its fields. Nothing writes on mount.
 * @param props - marker, private APIs, per-call state and store actions.
 * @returns the private form.
 */
export function PrivateForm(props: Omit<FormCommonProps, 'locked'> & {
  readonly form: FormMarker
  readonly applicationApi: ApplicationFormApi
  readonly offerApi: OfferFormApi
  readonly locks: Readonly<Record<string, boolean>>
}) {
  const { form, applicationApi, offerApi, locks } = props
  const targetKey = form.form === 'offer' ? `offer:${form.applicationId}`
    : form.applicationId === null ? 'application:create' : `application:upload:${form.applicationId}`
  const locked = props.state.locked || props.state.phase === 'saving' || locks[targetKey] === true
  const [catalog, setCatalog] = useState<ApplicationCatalog | null>(null)
  const [target, setTarget] = useState<UploadTarget | null>(null)
  const [draft, setDraft] = useState<OfferDraft | null>(null)
  const [tokenization, setTokenization] = useState(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    if (props.state.phase !== 'idle') return
    const { actions, callId } = props
    actions.formBegin(callId)
    void (async () => {
      try {
        if (form.form === 'offer') {
          const [loaded, choices, loadedTarget] = await Promise.all([
            offerApi.load(form.applicationId), loadCatalog(applicationApi), applicationApi.target(form.applicationId),
          ])
          if (!mounted.current) return
          setCatalog(choices)
          setTarget(loadedTarget)
          setDraft(loaded)
          actions.formReady(callId, draftValues(loaded), loaded?.offer_scholarships ?? [])
          return
        }
        if (form.applicationId === null && !await applicationApi.creationAvailable()) {
          if (mounted.current) setTokenization(true)
          throw new ApplicationFormError('unavailable')
        }
        const [choices, loadedTarget] = await Promise.all([
          loadCatalog(applicationApi),
          form.applicationId === null ? Promise.resolve(null) : applicationApi.target(form.applicationId),
        ])
        if (!mounted.current) return
        setCatalog(choices)
        setTarget(loadedTarget)
        actions.formReady(callId, {}, [])
      } catch (error) {
        if (mounted.current) {
          props.actions.formFailed(props.callId, formFailure(error))
        }
      }
    })()
  }, [props.state.phase, props.callId, props.actions, form, applicationApi, offerApi])

  const title = form.form === 'offer'
    ? props.t(draft === null ? 'form.offer.title.create' : 'form.offer.title.edit')
    : form.applicationId === null
      ? props.t('form.application.title.create')
      : props.t('form.application.title.upload', { reference: target?.reference ?? `#${form.applicationId}` })

  return <div className={css.form}>
    <h3 className={css.header}>{title}</h3>
    {props.state.phase === 'loading' && <p className={css.hint}>{props.t('form.loading')}</p>}
    {tokenization && <p className={css.notice} role="alert">{props.t('form.error.tokenization')}</p>}
    {props.state.error !== null && <p className={css.notice} role="alert">{props.t(FORM_ERROR_KEYS[props.state.error])}</p>}
    {props.state.error === 'sign-in' && <a href={props.signInUrl}>{props.t('form.action.signIn')}</a>}
    {props.state.phase === 'failed' && props.state.error !== 'unknown' && !tokenization && (
      <Button size="sm" variant="ghost" onClick={() => { props.actions.formRetry(props.callId) }}>
        {props.t('action.retry')}
      </Button>
    )}

    {form.form === 'application' && catalog !== null && (
      <ApplicationPrivateForm
        mode={form.applicationId === null ? 'create' : 'upload'}
        applicationId={form.applicationId}
        catalog={catalog}
        target={target}
        applicationApi={applicationApi}
        targetKey={targetKey}
        common={{ ...props, locked }}
      />
    )}
    {form.form === 'offer' && catalog !== null && (
      <OfferPrivateForm
        applicationId={form.applicationId}
        catalog={catalog}
        draft={draft}
        target={target}
        offerApi={offerApi}
        targetKey={targetKey}
        onSaved={setDraft}
        common={{ ...props, locked }}
      />
    )}
  </div>
}
