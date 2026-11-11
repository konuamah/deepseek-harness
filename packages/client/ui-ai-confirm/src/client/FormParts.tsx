/** Reused controls for the private staff forms. */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DocumentChoice } from './application-form-api.ts'
import type { FormTotals } from './confirm-store.ts'
import type { Translate } from './form-types.ts'
import { OFFER_FIELDS, type OfferValues } from './offer-fields.ts'
import type { OfferScholarship } from './offer-form-api.ts'
import css from './PrivateForm.module.css'

const FEE_NAMES = new Set([
  'tuition_fee', 'registration_fee', 'admission_fee', 'accommodation_fee',
  'exam_assessment_fee', 'student_services_fee', 'graduation_exit_fee', 'other_fees',
])

/** A labelled select over private catalog choices. */
export function Choice({ label, value, onChange, choices, choose, disabled }: {
  readonly label: string
  readonly value: string
  readonly onChange: (value: string) => void
  readonly choices: readonly { readonly id: number; readonly name: string }[]
  readonly choose: string
  readonly disabled: boolean
}) {
  return <label className={css.field}>
    <span>{label}</span>
    <select value={value} onChange={(event) => { onChange(event.currentTarget.value) }} disabled={disabled} required>
      <option value="">{choose}</option>
      {choices.map(choice => <option key={choice.id} value={choice.id}>{choice.name}</option>)}
    </select>
  </label>
}

/** One file input per document type, plus the types already attached to the target. */
export function Documents({ title, choices, attachedNames, files, disabled, onChoose, t }: {
  readonly title: string
  readonly choices: readonly DocumentChoice[]
  readonly attachedNames: readonly string[]
  readonly files: Readonly<Record<number, File>>
  readonly disabled: boolean
  readonly onChoose: (documentType: number, chosen: FileList | null) => void
  readonly t: Translate
}) {
  return <fieldset className={css.section}>
    <legend>{title}</legend>
    {attachedNames.map(name => <p className={css.hint} key={name}>{t('form.application.attached')} · {name}</p>)}
    {choices.length === 0 && attachedNames.length === 0 && <p className={css.hint}>{t('form.application.noDocuments')}</p>}
    {choices.map((choice) => {
      const accept = choice.acceptedFormats.split(',').map(value => value.trim()).filter(Boolean)
        .map(value => `.${value}`).join(',')
      return <label className={css.field} key={choice.id}>
        <span>{choice.name} · {choice.acceptedFormats} · {choice.maxSizeMb} MB</span>
        <input type="file" accept={accept} disabled={disabled}
          onChange={(event) => { onChoose(choice.id, event.currentTarget.files) }} />
        {files[choice.id] !== undefined && <span className={css.hint}>{files[choice.id]?.name}</span>}
      </label>
    })}
  </fieldset>
}

/** The eight fee fields and the offer detail fields. */
export function OfferFields({ values, onChange, disabled, t }: {
  readonly values: OfferValues
  readonly onChange: (name: string, value: string) => void
  readonly disabled: boolean
  readonly t: Translate
}) {
  const render = (fee: boolean) => OFFER_FIELDS.filter(field => FEE_NAMES.has(field.name) === fee).map(field =>
    <OfferField key={field.name} field={field} value={values[field.name] ?? ''} onChange={onChange} disabled={disabled} t={t} />)
  return <div className={css.fields}>
    <fieldset className={css.section}><legend>{t('section.fees')}</legend>{render(true)}</fieldset>
    <fieldset className={css.section}><legend>{t('section.details')}</legend>{render(false)}</fieldset>
  </div>
}

function OfferField({ field, value, onChange, disabled, t }: {
  readonly field: (typeof OFFER_FIELDS)[number]
  readonly value: string
  readonly onChange: (name: string, value: string) => void
  readonly disabled: boolean
  readonly t: Translate
}) {
  const label = t(`form.field.${field.name}`)
  const maxLength = 'maxLength' in field ? field.maxLength : undefined
  if (field.type === 'checkbox') {
    return <label className={css.field}><span>
      <input type="checkbox" checked={value === 'true'} disabled={disabled}
        onChange={(event) => { onChange(field.name, String(event.currentTarget.checked)) }} /> {label}
    </span></label>
  }
  if (field.type === 'textarea') {
    return <label className={css.field}><span>{label}</span>
      <textarea value={value} maxLength={maxLength} disabled={disabled} rows={3}
        onChange={(event) => { onChange(field.name, event.currentTarget.value) }} />
    </label>
  }
  return <label className={css.field}><span>{label}</span>
    <input type={field.type === 'number' ? 'text' : field.type} inputMode={field.type === 'number' ? 'decimal' : undefined}
      value={value} maxLength={maxLength} disabled={disabled}
      onChange={(event) => { onChange(field.name, event.currentTarget.value) }} />
  </label>
}

/** Scholarship lines; an existing line whose scholarship is inactive stays visible and removable. */
export function Scholarships({ scholarships, choices, disabled, onChange, t }: {
  readonly scholarships: readonly OfferScholarship[]
  readonly choices: readonly { readonly id: number; readonly name: string }[]
  readonly disabled: boolean
  readonly onChange: (lines: readonly OfferScholarship[]) => void
  readonly t: Translate
}) {
  const used = new Set(scholarships.map(line => line.scholarship))
  const next = choices.find(choice => !used.has(choice.id))
  const update = (index: number, change: Partial<OfferScholarship>) => {
    onChange(scholarships.map((line, i) => i === index ? { ...line, ...change } : line))
  }
  return <fieldset className={css.section}>
    <legend>{t('form.offer.scholarships')}</legend>
    {scholarships.map((line, index) => <div className={css.summary} key={`${line.scholarship}-${index}`}>
      <label className={css.field}><span>{t('form.offer.selectScholarship')}</span>
        <select value={line.scholarship} disabled={disabled}
          onChange={(event) => { update(index, { scholarship: Number(event.currentTarget.value) }) }}>
          {choices.filter(choice => choice.id === line.scholarship || !used.has(choice.id)).map(choice =>
            <option key={choice.id} value={choice.id}>{choice.name}</option>)}
          {!choices.some(choice => choice.id === line.scholarship)
            && <option value={line.scholarship}>{t('form.offer.scholarshipInactive', { name: `#${line.scholarship}` })}</option>}
        </select>
      </label>
      <label className={css.field}><span>{t('form.offer.amount')}</span>
        <input inputMode="decimal" value={line.amount} disabled={disabled}
          onChange={(event) => { update(index, { amount: event.currentTarget.value }) }} />
      </label>
      <label className={css.field}><span>{t('form.offer.notes')}</span>
        <input value={line.notes} maxLength={5000} disabled={disabled}
          onChange={(event) => { update(index, { notes: event.currentTarget.value }) }} />
      </label>
      <Button size="sm" variant="ghost" disabled={disabled}
        onClick={() => { onChange(scholarships.filter((_, i) => i !== index)) }}>{t('form.offer.remove')}</Button>
    </div>)}
    <Button size="sm" variant="ghost" disabled={disabled || next === undefined}
      onClick={() => { if (next !== undefined) onChange([...scholarships, { scholarship: next.id, amount: '0.00', notes: '' }]) }}>
      {t('form.offer.addScholarship')}
    </Button>
  </fieldset>
}

/** Server-computed offer totals. */
export function Totals({ totals, currency, t }: {
  readonly totals: FormTotals
  readonly currency: string
  readonly t: Translate
}) {
  return <dl className={css.summary}>
    <div><dt>{t('form.offer.totalFees')}</dt><dd>{totals.totalFees} {currency}</dd></div>
    <div><dt>{t('form.offer.totalScholarships')}</dt><dd>{totals.totalScholarships} {currency}</dd></div>
    <div><dt>{t('form.offer.netPayable')}</dt><dd>{totals.netFeePayable} {currency}</dd></div>
  </dl>
}

/** Inline discard confirmation, shared by both forms. */
export function DiscardPrompt({ onKeep, onDiscard, t }: {
  readonly onKeep: () => void
  readonly onDiscard: () => void
  readonly t: Translate
}) {
  return <div className={css.notice} role="alert">
    <strong>{t('form.discard')}</strong> {t('form.discardNote')}
    <div className={css.actions}>
      <Button size="sm" variant="ghost" onClick={onKeep}>{t('form.action.keepEditing')}</Button>
      <Button size="sm" variant="ghost" onClick={onDiscard}>{t('form.action.discard')}</Button>
    </div>
  </div>
}
