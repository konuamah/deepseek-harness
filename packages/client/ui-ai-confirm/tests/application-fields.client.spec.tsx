// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApplicationFields } from '../src/client/ApplicationFields.tsx'
import { APPLICATION_FIELDS, applicationBody } from '../src/client/application-fields.ts'
import { applicationEn } from '../src/client/application-locales.ts'

afterEach(cleanup)

const translate = (key: keyof typeof applicationEn): string => applicationEn[key]

describe('application fields', () => {
  it('renders required and optional fields with native constraints and reports edits', () => {
    const onChange = vi.fn()
    render(<ApplicationFields values={{}} onChange={onChange} disabled={false} t={translate} />)
    const email = screen.getByLabelText('Email address') as HTMLInputElement
    const birth = screen.getByLabelText('Date of birth') as HTMLInputElement
    const year = screen.getByLabelText('Year completed') as HTMLInputElement
    expect(email.required).toBe(true)
    expect(email.maxLength).toBe(254)
    expect(screen.getByLabelText('Phone number').getAttribute('required')).toBeNull()
    expect(birth.max).toBe(new Date().toLocaleDateString('en-CA'))
    expect(year.min).toBe('1950')
    fireEvent.change(email, { target: { value: 'person@example.test' } })
    expect(onChange).toHaveBeenCalledWith('email', 'person@example.test')
  })

  it('builds multipart fields while omitting blank optional values and false terms', () => {
    const values: Record<string, string> = { first_name: 'A', last_name: 'B', email: 'a@b.test', other_names: '', phone_number: '123' }
    const body = applicationBody(values, '4', '', false)
    expect(body.get('first_name')).toBe('A')
    expect(body.get('phone_number')).toBe('123')
    expect(body.has('other_names')).toBe(false)
    expect(body.has('intake')).toBe(false)
    expect(body.has('accepted_terms')).toBe(false)
    expect(body.get('program')).toBe('4')
    expect(APPLICATION_FIELDS.every(field => field.required || values[field.name] !== undefined || !body.has(field.name))).toBe(true)
  })

  it('includes accepted terms only when true', () => {
    expect(applicationBody({}, '1', '2', true).get('accepted_terms')).toBe('true')
    expect(applicationBody({}, '1', '2', true).get('intake')).toBe('2')
  })
})
