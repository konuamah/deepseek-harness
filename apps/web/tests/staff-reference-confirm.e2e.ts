/** Reference confirmation through recorded calls and the shipped Web composition; writes are mocked. */
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, readPersistedEvents, seedSession, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/staff-reference-confirm', import.meta.url))
const OVERLAY = fileURLToPath(new URL('./staff-cards.overlay.yml', import.meta.url))
const MODE = webSnapshotMode()
const LABEL = 'Retype the application reference to confirm'

const ACTIONS = [
  { id: 2048, action: 'application.enroll', endpoint: 'enroll', title: 'Enrol 1 application', reason: 'Synthetic fee waiver' },
  { id: 2049, action: 'offer.send', endpoint: 'send_offer', title: 'Send 1 offer letter', reason: '' },
] as const

describe('web e2e: staff reference confirmation', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let sessionId: Awaited<ReturnType<typeof seedSession>>
  const minted: unknown[] = []
  const writes: object[] = []
  const changed = new Set<number>()

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY })
    sessionId = await seedSession(scaffold,
      await readFile(join(SNAPSHOT_DIR, 'session.v4.jsonl'), 'utf8'), 'staff-reference-confirm', 'staff')
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await page.route('**/tools/pending/**', (route) => {
      const url = route.request().url()
      const spec = url.includes('426614174001') ? ACTIONS[0] : ACTIONS[1]
      return route.fulfill({ json: {
        id: url.split('/').at(-1), action: spec.action, ids: [spec.id], reason: spec.reason,
        expiresAt: '2099-01-01T00:00:00Z',
      } })
    })
    await page.route('**/api/v1/admissions/staff/application-summaries/**', (route) => {
      const ids = new URL(route.request().url()).searchParams.get('ids')?.split(',').map(Number) ?? []
      return route.fulfill({ json: { applications: ids.map(id => ({
        id, name: 'Synthetic Applicant', reference: `APP-${id}`,
        status: changed.has(id) ? 'ENROLLED' : 'APPROVED',
        program: { code: 'MSc', name: 'MSc Computing' },
      })) } })
    })
    await page.route('**/api/v1/users/csrf-token/', route => route.fulfill({ json: { csrfToken: 'fixture-csrf' } }))
    await page.route('**/api/v1/ai/token/', (route) => {
      minted.push(route.request().postDataJSON())
      return route.fulfill({ json: { token: 'fixture-write-token' } })
    })
    await page.route('**/api/v1/admissions/applications/*/*/', (route) => {
      const request = route.request()
      const body: unknown = request.postDataJSON()
      writes.push({ path: new URL(request.url()).pathname, body, authorization: request.headers().authorization })
      if (request.url().endsWith('/2048/enroll/')) changed.add(2048)
      return route.fulfill({ json: {} })
    })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('[role="treeitem"]').first().click()
    await page.locator('[role="treeitem"]').nth(1).click()
    await page.locator('[data-tool="ai-confirm"][data-state="ready"]').nth(1).waitFor()
  }, 120_000)

  afterAll(async () => {
    try { await browser?.close() } finally { await scaffold?.close() }
  })

  it('requires exact browser-entered references and keeps them out of the session log', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-staff-reference-confirm'))
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'ui.expected.md'),
      await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd), MODE)
    const shots = fileURLToPath(new URL('../../../.artifacts/staff-reference-confirm', import.meta.url))
    await mkdir(shots, { recursive: true })
    for (const width of [1680, 390]) {
      await page.setViewportSize({ width, height: 1000 })
      const drawer = page.getByRole('dialog', { name: 'Navigation', exact: true })
      if (await drawer.isVisible()) await drawer.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
      const card = page.locator('[data-tool="ai-confirm"]').first()
      expect(await card.getByRole('textbox', { name: LABEL }).evaluate((input) => {
        const field = input.getBoundingClientRect()
        const card = input.closest('[data-tool="ai-confirm"]')!.getBoundingClientRect()
        return field.left >= card.left && field.right <= card.right
      })).toBe(true)
      for (const dark of [false, true]) {
        await page.evaluate(value => document.body.toggleAttribute('data-ds-dark-theme', value), dark)
        await page.locator('[data-tool="ai-confirm"]').first().screenshot({
          path: join(shots, `${width}-${dark ? 'dark' : 'light'}.png`), animations: 'disabled',
        })
      }
    }
    await page.setViewportSize({ width: 1680, height: 1000 })
    await page.evaluate(() => { document.body.removeAttribute('data-ds-dark-theme') })
    for (const spec of ACTIONS) {
      const card = page.locator('[data-tool="ai-confirm"]').filter({ has: page.getByRole('heading', { name: spec.title }) })
      const field = card.getByRole('textbox', { name: LABEL })
      const confirm = card.getByRole('button', { name: 'Confirm', exact: true })
      expect(await confirm.isEnabled()).toBe(false)
      await field.fill('WRONG-REFERENCE')
      expect(await field.getAttribute('aria-invalid')).toBe('true')
      expect(await confirm.isEnabled()).toBe(false)
      await field.fill(`APP-${spec.id}`)
      expect(await confirm.isEnabled()).toBe(true)
      if (spec.action === 'offer.send') expect(await card.innerText()).not.toContain('→')
      await confirm.click()
      await expect.poll(() => card.getAttribute('data-state')).toBe('done')
    }
    expect(minted).toEqual(ACTIONS.map(spec => ({
      kind: 'write', action: spec.action, ids: [spec.id], confirm_reference: `APP-${spec.id}`,
      ...spec.reason === '' ? {} : { reason: spec.reason },
    })))
    expect(writes).toEqual(ACTIONS.map(spec => ({
      path: `/api/v1/admissions/applications/${spec.id}/${spec.endpoint}/`,
      body: { confirm_reference: `APP-${spec.id}`, ...spec.reason === '' ? {} : { reason: spec.reason } },
      authorization: 'Bearer fixture-write-token',
    })))
    const log = JSON.stringify(await readPersistedEvents(scaffold, sessionId))
    for (const privateValue of ['WRONG-REFERENCE', 'APP-2048', 'APP-2049', 'fixture-write-token']) {
      expect(log).not.toContain(privateValue)
    }
    await assertFixtureInventory(SNAPSHOT_DIR, ['session.v4.jsonl', 'ui.expected.md'])
  })
})
