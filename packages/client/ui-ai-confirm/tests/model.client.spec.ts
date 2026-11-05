/** Prepared-batch parsing and the static tables the card reads. */
import { describe, expect, it } from 'vitest'
import { ACTIONS, isId, isRecord, parsePrepared, statusAfter, shownName, statusKey, wireName } from '../src/client/model.ts'

const ID = '0b1d2c3e-4f50-4a61-8b72-93a4b5c6d7e8'

const batch = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    pendingActionId: ID,
    action: 'application.approve',
    eligible: [{ id: 7, status: 'UNDER_REVIEW' }],
    skipped: [{ id: 8, status: 'APPROVED', why: 'cannot be approved from this status' }],
    expiresAt: '2026-11-03T15:00:00.000Z',
    ...overrides,
  })

describe('parsePrepared', () => {
  it('reads a well-formed batch', () => {
    expect(parsePrepared(batch())).toEqual({
      pendingActionId: ID,
      action: 'application.approve',
      eligible: [{ id: 7, status: 'UNDER_REVIEW' }],
      skipped: [{ id: 8, status: 'APPROVED', why: 'cannot be approved from this status' }],
      expiresAt: '2026-11-03T15:00:00.000Z',
    })
  })

  it('accepts a skipped record that was not found', () => {
    const parsed = parsePrepared(batch({ skipped: [{ id: 999, status: null, why: 'not found' }] }))

    expect(parsed?.skipped).toEqual([{ id: 999, status: null, why: 'not found' }])
  })

  it('accepts an empty skipped list', () => {
    expect(parsePrepared(batch({ skipped: [] }))?.skipped).toEqual([])
  })

  it.each([
    ['text that is not JSON', 'Nothing can be prepared.'],
    ['a JSON array', '[]'],
    ['JSON null', 'null'],
    ['a malformed pending action id', batch({ pendingActionId: 'not-a-uuid' })],
    ['a missing pending action id', batch({ pendingActionId: undefined })],
    ['a missing action', batch({ action: undefined })],
    ['a missing expiry', batch({ expiresAt: undefined })],
    ['no eligible records', batch({ eligible: [] })],
    ['eligible that is not a list', batch({ eligible: {} })],
    ['too many eligible records', batch({ eligible: Array.from({ length: 26 }, (_, index) => ({ id: index + 1, status: 'PENDING' })) })],
    ['an eligible record with a bad id', batch({ eligible: [{ id: 0, status: 'PENDING' }] })],
    ['an eligible record with no status', batch({ eligible: [{ id: 3 }] })],
    ['an eligible entry that is not an object', batch({ eligible: [3] })],
    ['a skipped record with no reason', batch({ skipped: [{ id: 8, status: 'APPROVED' }] })],
    ['a skipped record with a bad status type', batch({ skipped: [{ id: 8, status: 5, why: 'x' }] })],
    ['a skipped entry that is not an object', batch({ skipped: ['x'] })],
  ])('rejects %s', (_label, text) => {
    expect(parsePrepared(text)).toBeNull()
  })
})

describe('guards', () => {
  it('tells objects from other JSON', () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord([])).toBe(false)
    expect(isRecord(null)).toBe(false)
    expect(isRecord('x')).toBe(false)
  })

  it('accepts only positive integer ids', () => {
    expect(isId(3)).toBe(true)
    expect([0, -1, 1.5, '3', null, Number.NaN].some(isId)).toBe(false)
  })
})

describe('tables', () => {
  it('names the six prepare tools with the MCP wire prefix', () => {
    expect(ACTIONS.map(spec => wireName('cinhed', spec))).toEqual([
      'mcp__cinhed__prepare_approve',
      'mcp__cinhed__prepare_reject',
      'mcp__cinhed__prepare_request_documents',
      'mcp__cinhed__prepare_cancel',
      'mcp__cinhed__prepare_verify_document',
      'mcp__cinhed__prepare_reject_document',
    ])
  })

  it('matches each action to the Django write it stands for', () => {
    expect(ACTIONS.map(spec => [spec.action, spec.resource, spec.endpoint, spec.reason])).toEqual([
      ['application.approve', 'application', 'approve', 'none'],
      ['application.reject', 'application', 'reject', 'optional'],
      ['application.request_documents', 'application', 'request_documents', 'required'],
      ['application.cancel', 'application', 'cancel', 'none'],
      ['application_document.verify', 'document', 'verify', 'none'],
      ['application_document.reject', 'document', 'reject_document', 'required'],
    ])
  })

  it('labels every application status and passes unknown ones through', () => {
    expect(statusKey('UNDER_REVIEW')).toBe('status.underReview')
    expect(statusKey('DOCUMENTS_REQUIRED')).toBe('status.documentsRequired')
    expect(statusKey('SOMETHING_NEW')).toBeUndefined()
    expect(statusKey('toString')).toBeUndefined()
  })

  it('hides names that are empty or look like an email address', () => {
    expect(shownName('Ama Fakename')).toBe('Ama Fakename')
    expect(shownName('')).toBeUndefined()
    expect(shownName('  ')).toBeUndefined()
    expect(shownName('ama@example.com')).toBeUndefined()
  })

  it('knows the status each action leaves behind', () => {
    expect(statusAfter('application.approve')).toBe('APPROVED')
    expect(statusAfter('application.reject')).toBe('REJECTED')
    expect(statusAfter('application.request_documents')).toBe('DOCUMENTS_REQUIRED')
    expect(statusAfter('application.cancel')).toBe('CANCELLED')
    expect(statusAfter('application_document.verify')).toBe('VERIFIED')
    expect(statusAfter('application_document.reject')).toBe('REJECTED')
    expect(statusAfter('application.delete')).toBeUndefined()
  })
})
