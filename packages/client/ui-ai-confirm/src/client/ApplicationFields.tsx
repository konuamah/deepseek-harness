import { Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ApplicationField } from './application-fields.ts'
import { APPLICATION_FIELDS, type ApplicationValues } from './application-fields.ts'
import type { ApplicationFieldKey } from './application-locales.ts'
import css from './PrivateForm.module.css'

/** Render applicant-entered details; validation and files remain owned by the form parent. */
export function ApplicationFields({
  values,
  onChange,
  disabled,
  t,
}: {
  readonly values: ApplicationValues
  readonly onChange: (name: string, value: string) => void
  readonly disabled: boolean
  readonly t: (key: ApplicationFieldKey) => string
}) {
  return <div className={css.fields}>{(['identity', 'contact', 'education'] as const).map(section => (
    <fieldset className={css.section} key={section} disabled={disabled}>
      <legend>{t(`section.${section}`)}</legend>
      {APPLICATION_FIELDS.filter(field => field.section === section).map(field => (
        <ApplicationInput key={field.name} field={field} values={values} onChange={onChange} t={t} />
      ))}
    </fieldset>
  ))}</div>
}

function ApplicationInput({
  field,
  values,
  onChange,
  t,
}: {
  readonly field: ApplicationField
  readonly values: ApplicationValues
  readonly onChange: (name: string, value: string) => void
  readonly t: (key: ApplicationFieldKey) => string
}) {
  const label = t(`form.field.${field.name}` as ApplicationFieldKey)
  const today = new Date()
  const maxDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  return <label className={css.field}>
    <span>{label}</span>
    <Input
      name={field.name}
      type={field.type ?? 'text'}
      value={values[field.name] ?? ''}
      onChange={(event) => { onChange(field.name, event.currentTarget.value) }}
      required={field.required}
      maxLength={field.maxLength}
      min={field.min}
      max={field.type === 'number' ? today.getFullYear() : field.type === 'date' ? maxDate : undefined}
    />
  </label>
}
