/** Public application text fields mirrored from PublicApplicationCreateSerializer. */
export interface ApplicationField {
  readonly name: string
  readonly type?: 'email' | 'date' | 'number' | 'tel' | 'text'
  readonly maxLength?: number
  readonly min?: number
  readonly required: boolean
  readonly section: 'identity' | 'contact' | 'education'
}

/** Applicant-entered fields, excluding parent-controlled choices, terms and uploads. */
export const APPLICATION_FIELDS = [
  { name: 'first_name', maxLength: 150, required: true, section: 'identity' },
  { name: 'last_name', maxLength: 150, required: true, section: 'identity' },
  { name: 'other_names', maxLength: 150, required: false, section: 'identity' },
  { name: 'date_of_birth', type: 'date', required: true, section: 'identity' },
  { name: 'place_of_birth', maxLength: 150, required: true, section: 'identity' },
  { name: 'passport_or_national_id_number', maxLength: 100, required: true, section: 'identity' },
  { name: 'gender', maxLength: 20, required: false, section: 'identity' },
  { name: 'title', maxLength: 10, required: false, section: 'identity' },
  { name: 'email', type: 'email', maxLength: 254, required: true, section: 'contact' },
  { name: 'phone_number', type: 'tel', maxLength: 20, required: false, section: 'contact' },
  { name: 'nationality', maxLength: 100, required: false, section: 'contact' },
  { name: 'address', maxLength: 255, required: true, section: 'contact' },
  { name: 'city', maxLength: 100, required: true, section: 'contact' },
  { name: 'country', maxLength: 100, required: true, section: 'contact' },
  { name: 'postal_code', maxLength: 20, required: true, section: 'contact' },
  { name: 'highest_qualification', maxLength: 150, required: true, section: 'education' },
  { name: 'institution_attended', maxLength: 200, required: true, section: 'education' },
  { name: 'year_completed', type: 'number', min: 1950, required: true, section: 'education' },
  { name: 'grade_or_result', maxLength: 100, required: false, section: 'education' },
  { name: 'agent_code', maxLength: 20, required: false, section: 'contact' },
] as const satisfies readonly ApplicationField[]

/** String values accepted by the applicant form. */
export type ApplicationValues = Readonly<Record<string, string>>

/** Assemble text values and parent-owned controls as multipart data; files are added by the parent. */
export function applicationBody(
  values: ApplicationValues,
  program: string,
  intake: string,
  acceptedTerms: boolean,
): FormData {
  const body = new FormData()
  for (const field of APPLICATION_FIELDS) {
    const value = values[field.name] ?? ''
    if (field.required || value !== '') body.append(field.name, value)
  }
  body.append('program', program)
  if (intake !== '') body.append('intake', intake)
  if (acceptedTerms) body.append('accepted_terms', 'true')
  return body
}
