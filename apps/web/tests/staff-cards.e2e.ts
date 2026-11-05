/** Recorded staff tool calls render outside the collapsed process and survive reopening. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, seedSession, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/staff-cards', import.meta.url))
const OVERLAY = fileURLToPath(new URL('./staff-cards.overlay.yml', import.meta.url))
const MODE = webSnapshotMode()

describe('web e2e: staff cards', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY })
    await seedSession(scaffold, await readFile(join(SNAPSHOT_DIR, 'session.v4.jsonl'), 'utf8'), 'staff-cards', 'staff')
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await page.route('**/tools/pending/**', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: '123e4567-e89b-42d3-a456-426614174000',
        action: 'application.cancel',
        ids: [2048],
        reason: '',
        expiresAt: '2099-01-01T00:00:00Z',
      }),
    }))
    await page.route('**/api/v1/admissions/staff/applications/2048/documents/**', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ documents: [] }),
    }))
    await page.route('**/api/v1/admissions/staff/application-summaries/**', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ applications: [{
        id: 2048, name: 'Ada Lovelace', reference: 'APP-2048', status: 'DRAFT',
        program: { code: 'MSc', name: 'MSc Computing' },
      }] }),
    }))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('[role="treeitem"]').first().click()
    await page.locator('[role="treeitem"]').nth(1).click()
    await page.locator('[data-tool="ai-applications"]').waitFor()
    await page.locator('[data-tool="ai-confirm"][data-state="ready"]').waitFor()
  }, 120_000)

  afterAll(async () => {
    try { await browser?.close() } finally { await scaffold?.close() }
  })

  it('keeps the lookup and preparation cards visible when the process is collapsed and reopened', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-staff-cards'))
    const process = page.locator('[data-turn-process]').first()
    expect(await process.getAttribute('aria-expanded')).toBe('false')
    const cards = page.locator('[data-tool="ai-applications"], [data-tool="ai-confirm"]')
    expect(await cards.count()).toBe(2)
    for (const card of await cards.all()) expect(await card.isVisible()).toBe(true)
    expect(await cards.nth(0).innerText()).toContain('APP-2048')
    expect(await cards.nth(0).innerText()).toContain('Ada Lovelace')
    expect(await cards.nth(1).innerText()).toContain('Cancel 1 application')
    await process.click()
    expect(await process.getAttribute('aria-expanded')).toBe('true')
    expect(await cards.count()).toBe(2)
    await process.click()
    expect(await process.getAttribute('aria-expanded')).toBe('false')
    expect(await cards.count()).toBe(2)
    for (const card of await cards.all()) expect(await card.isVisible()).toBe(true)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'ui.expected.md'),
      await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd), MODE)
    await assertFixtureInventory(SNAPSHOT_DIR, ['session.v4.jsonl', 'ui.expected.md'])
  })
})
