import { expect, test, type Page } from './fixtures'
import { openApp, openDemo, runSql } from './helpers'

/*
 * Quarry was renamed Sheetah. Someone who used the old name in this browser keeps their saved views,
 * history, theme and kept tables, and the old offline caches are cleaned up.
 */

/** Renames this origin's storage back to the pre-rebrand names, as an old visit would have left it. */
const rewindToQuarry = (page: Page) =>
  page.evaluate(async () => {
    for (const k of Object.keys(localStorage).filter((k) => k.startsWith('sheetah:'))) {
      localStorage.setItem(`quarry:${k.slice(8)}`, localStorage.getItem(k)!)
      localStorage.removeItem(k)
    }
    const root = await navigator.storage.getDirectory()
    const from = await root.getDirectoryHandle('sheetah-tables').catch(() => null)
    if (!from) return
    const to = await root.getDirectoryHandle('quarry-tables', { create: true })
    for await (const [name, handle] of from as unknown as AsyncIterable<[string, FileSystemFileHandle]>) {
      const out = await (await to.getFileHandle(name, { create: true })).createWritable()
      await out.write(await (await handle.getFile()).arrayBuffer())
      await out.close()
    }
    await root.removeEntry('sheetah-tables', { recursive: true })
  })

const folderExists = (page: Page, name: string) =>
  page.evaluate((n) => navigator.storage.getDirectory().then((d) => d.getDirectoryHandle(n)).then(() => true, () => false), name)

test('saved views, history, theme and kept tables carry over from the Quarry name', async ({ page }) => {
  await openDemo(page)
  await runSql(page, 'CREATE TABLE kept AS SELECT range AS id FROM range(42)')
  await runSql(page, 'SELECT count(*) AS n FROM kept')
  await page.getByRole('button', { name: 'Save view' }).click()
  await page.fill('#view-name', 'Old favourite')
  await page.locator('.modal .btn-primary').click()
  await page.getByRole('tab', { name: 'Tables' }).click() // saving a view switched to the Saved tab
  await page.getByLabel('Keep my tables in this browser').check()
  // Wait for the snapshot file itself (the folder appears before the file is written).
  await expect
    .poll(() =>
      page.evaluate(() =>
        navigator.storage.getDirectory().then((d) => d.getDirectoryHandle('sheetah-tables')).then((d) => d.getFileHandle('kept.arrow')).then(() => true, () => false),
      ),
    )
    .toBe(true)
  const toggle = page.getByRole('button', { name: /^Theme: / })
  await toggle.click() // Light
  await toggle.click() // Dark

  await rewindToQuarry(page)
  await page.reload()

  // Kept table restored from the old folder, which is then removed.
  await expect(page.locator('.toast', { hasText: 'Restored 1 table' })).toBeVisible({ timeout: 90_000 })
  await expect(page.locator('.side-name', { hasText: 'kept' })).toBeVisible()
  expect(await folderExists(page, 'quarry-tables')).toBe(false)
  expect(await folderExists(page, 'sheetah-tables')).toBe(true)

  // Theme applied before the app even started; views and history under the new names.
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.getByRole('tab', { name: /Saved/ }).click()
  await expect(page.locator('.side-view')).toContainText('Old favourite')
  await page.getByRole('tab', { name: 'History' }).click()
  await expect(page.locator('.side-history').first()).toContainText('count(*)')
  const keys = await page.evaluate(() => Object.keys(localStorage))
  expect(keys.filter((k) => k.startsWith('quarry:'))).toEqual([])
  expect(keys).toContain('sheetah:views')

  // "Clear all local data" leaves nothing behind under either name.
  await page.getByRole('button', { name: 'Clear all local data' }).click()
  await page.getByRole('button', { name: 'Yes, clear' }).click()
  await expect.poll(() => folderExists(page, 'sheetah-tables')).toBe(false)
  expect(await folderExists(page, 'quarry-tables')).toBe(false)
})

test('offline caches from the Quarry name are removed', async ({ page }) => {
  // A same-origin page that isn't the app, so the old cache exists before the service worker installs.
  await page.goto('/favicon.svg')
  await page.evaluate(async () => {
    const c = await caches.open('quarry-oldversion')
    await c.put('quarry-version', new Response('old'))
  })
  await openApp(page)
  await expect(page.locator('.engine-pill')).toContainText('works offline', { timeout: 90_000 })
  await expect.poll(() => page.evaluate(async () => (await caches.keys()).filter((k) => k.startsWith('quarry-')))).toEqual([])
})
