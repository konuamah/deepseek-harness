/** Shared types for the private staff forms. */
import type { FormFailure, FormState, FormTotals } from './confirm-store.ts'
import type { AiConfirmKey } from './locales.ts'
import type { OfferScholarship } from './offer-form-api.ts'

/** Translator supplied by the card slot. */
export type Translate = (key: AiConfirmKey, params?: Record<string, string | number>) => string

/** Locale key for each form failure. */
export const FORM_ERROR_KEYS: Record<FormFailure, AiConfirmKey> = {
  'sign-in': 'form.error.signIn',
  invalid: 'form.error.invalid',
  unavailable: 'form.error.unavailable',
  unknown: 'form.error.unknown',
}

/** Store changes the forms use. */
export interface FormActions {
  formBegin(key: string): void
  formRetry(key: string): void
  formReady(key: string, values: Readonly<Record<string, string>>, scholarships: readonly OfferScholarship[]): void
  formReset(key: string, values: Readonly<Record<string, string>>, scholarships: readonly OfferScholarship[]): void
  formEdit(key: string, name: string, value: string): void
  formTerms(key: string, terms: boolean): void
  formDocuments(key: string, ids: readonly number[]): void
  formScholarships(key: string, scholarships: readonly OfferScholarship[]): void
  formSaving(key: string): void
  formSaved(key: string, saved: {
    reference?: string | undefined
    createdNew?: boolean | undefined
    totals?: FormTotals | undefined
  }): void
  formFailed(key: string, kind: FormFailure): void
  lockTarget(target: string): void
  unlockTarget(target: string): void
}

/** Props every private form branch shares. */
export interface FormCommonProps {
  readonly callId: string
  readonly state: FormState
  readonly locked: boolean
  readonly actions: FormActions
  readonly t: Translate
  readonly signInUrl: string
}
