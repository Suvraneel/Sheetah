import { expect, type Page } from '@playwright/test'
import { join } from 'node:path'
import { FIXTURES } from './global-setup'

export const fixture = (name: string) => join(FIXTURES, name)
export const committedFixture = (name: string) => join(import.meta.dirname, 'fixtures', name)

/** Opens Sheetah and waits until the sealed engine is ready. */
export async function openApp(page: Page, path = '/') {
  await page.goto(path)
  await expect(page.locator('.engine-pill.is-ready')).toBeVisible({ timeout: 90_000 })
}

export async function openDemo(page: Page) {
  await openApp(page)
  await page.getByRole('button', { name: /Try 1,000,000 sample rows/ }).click()
  await expect(page.locator('.result-meta')).toContainText('1,000,000 rows', { timeout: 60_000 })
}

export async function openFiles(page: Page, ...paths: string[]) {
  await page.locator('input[type=file]').setInputFiles(paths)
}

/** Replaces the editor contents and runs it. */
export async function runSql(page: Page, sql: string) {
  await page.locator('.cm-content').click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.press('Delete')
  await page.keyboard.insertText(sql)
  await page.keyboard.press('ControlOrMeta+Enter')
}

export async function gridTop(page: Page) {
  return (await page.locator('.grid-scroll').boundingBox())!.y
}

/**
 * Records every request to another origin that actually went out: ones that completed, and ones that
 * failed on the network. Requests the browser refused before sending (CSP) don't count: nothing left.
 */
export function recordEgress(page: Page) {
  const out: string[] = []
  const external = (u: string) => !u.startsWith('http://localhost') && !u.startsWith('blob:') && !u.startsWith('data:')
  page.on('requestfinished', (r) => external(r.url()) && out.push(r.url()))
  page.on('requestfailed', (r) => {
    const reason = r.failure()?.errorText ?? ''
    if (external(r.url()) && !/CSP|blocked/i.test(reason)) out.push(`${r.url()} (${reason})`)
  })
  return out
}

export async function metaText(page: Page) {
  return page.locator('.result-meta').innerText()
}

/** Picks a format from the result's Export menu and returns the download. */
export async function exportAs(page: Page, format: 'Excel (.xlsx)' | 'Excel, with the rows behind it' | 'CSV' | 'CSV, exact values' | 'Parquet') {
  await page.getByRole('button', { name: 'Export' }).click()
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: format, exact: true }).click()])
  return dl
}
