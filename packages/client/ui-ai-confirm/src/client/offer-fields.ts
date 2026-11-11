/** Staff draft offer fields mirrored from the bounded staff serializer. */
import type { OfferDraft } from './offer-form-api.ts'

export interface OfferField {
  readonly name: string
  readonly type: 'text' | 'number' | 'date' | 'checkbox' | 'textarea'
  readonly maxLength?: number
  readonly required?: boolean
}

/** Fee and detail fields accepted by DraftOfferInput; currency and scholarships are parent-owned. */
export const OFFER_FIELDS = [
  { name: 'tuition_fee', type: 'number' },
  { name: 'registration_fee', type: 'number' },
  { name: 'admission_fee', type: 'number' },
  { name: 'accommodation_fee', type: 'number' },
  { name: 'exam_assessment_fee', type: 'number' },
  { name: 'student_services_fee', type: 'number' },
  { name: 'graduation_exit_fee', type: 'number' },
  { name: 'other_fees', type: 'number' },
  { name: 'other_fees_description', type: 'textarea', maxLength: 5000 },
  { name: 'program_duration', type: 'text', maxLength: 50 },
  { name: 'study_mode', type: 'text', maxLength: 20 },
  { name: 'program_start_date', type: 'date' },
  { name: 'partner_institution', type: 'text', maxLength: 200 },
  { name: 'prepared_by_name', type: 'text', maxLength: 200 },
  { name: 'requires_visa_flight', type: 'checkbox' },
  { name: 'notes', type: 'textarea', maxLength: 5000 },
] as const satisfies readonly OfferField[]

/** String-valued offer form data, including checkbox values as `true` or `false`. */
export type OfferValues = Readonly<Record<string, string>>

/** Values a persisted draft holds, for the form and for comparison. */
export function draftValues(draft: OfferDraft | null): Record<string, string> {
  if (draft === null) return {}
  const values: Record<string, string> = {}
  for (const field of OFFER_FIELDS) {
    const value = draft[field.name as keyof OfferDraft]
    values[field.name] = typeof value === 'string' ? value : typeof value === 'boolean' ? String(value) : ''
  }
  return values
}

/** Existing values for comparing the editable form with the persisted draft. */
export type ExistingOfferValues = Readonly<Record<string, string>> | null

/** One field's wire value, or undefined when the request should omit it. */
function bodyValue(field: (typeof OFFER_FIELDS)[number], value: string, existing: ExistingOfferValues): unknown {
  if (existing === null) {
    if (field.name === 'program_start_date') return value === '' ? undefined : value
    if (field.type === 'checkbox') return value === '' ? undefined : value === 'true'
    return ('required' in field && field.required) || value !== '' ? value : undefined
  }
  if (value === (existing[field.name] ?? '')) return undefined
  if (field.name === 'program_start_date') return value || null
  return field.type === 'checkbox' ? value === 'true' : value
}

/** Return only changed serializer fields; blank nullable fees defer to model defaults on create. */
export function offerBody(
  values: OfferValues,
  scholarships: readonly { readonly scholarship: number; readonly amount: string; readonly notes: string }[],
  existing: ExistingOfferValues,
  existingScholarships: readonly { readonly scholarship: number; readonly amount: string; readonly notes: string }[],
): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  for (const field of OFFER_FIELDS) {
    const value = bodyValue(field, values[field.name] ?? '', existing)
    if (value !== undefined) body[field.name] = value
  }
  if (JSON.stringify(scholarships) !== JSON.stringify(existingScholarships)) body.offer_scholarships = scholarships
  return body
}
