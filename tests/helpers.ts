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
 * Records every request that isn't for one of the site's own files and actually went out: ones that
 * completed, and ones that failed on the network. Requests the browser refused before sending (CSP) don't
 * count: nothing left.
 */
export function recordEgress(page: Page) {
  const out: string[] = []
  // Anything but the site's own files: another host, or a request to this one that isn't a file the build
  // serves (data sent to the app's own origin would leave the tab just the same).
  const own = (u: string) => {
    if (!u.startsWith('http://localhost')) return false
    const path = new URL(u).pathname
    return path === '/' || /^\/(assets|icons|duckdb-extensions)\//.test(path) || /^\/[\w.-]+\.(js|css|json|svg|png|ico|webmanifest|html|wasm|txt|xml)$/.test(path)
  }
  const external = (u: string) => !own(u) && !u.startsWith('blob:') && !u.startsWith('data:')
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
