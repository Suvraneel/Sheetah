import { expect, test } from './fixtures'
import { openApp, openDemo } from './helpers'

test.describe('workspace conveniences', () => {
  test('starter queries run on the sample; monthly revenue charts by month', async ({ page }) => {
    await openDemo(page)
    const starters = page.getByRole('navigation', { name: 'Example queries' })
    await starters.getByRole('button', { name: 'Revenue by city' }).click()
    await expect(page.locator('.result-meta')).toContainText('14 rows')

    // Already-monthly data must chart by month (not shifted to the Monday of each week).
    await starters.getByRole('button', { name: 'Monthly revenue' }).click()
    await expect(page.locator('.result-meta')).toContainText('21 rows')
    await expect(page.locator('.chart-figure figcaption')).toContainText('by month')

    await starters.getByRole('button', { name: 'Hide example queries' }).click()
    await expect(starters).toHaveCount(0)
  })

  test('your own table gets example queries built from its columns', async ({ page }) => {
    await openApp(page)
    const rows = Array.from({ length: 60 }, (_, i) => `${i},${['North', 'South', 'East'][i % 3]},2024-0${1 + (i % 3)}-1${i % 9},${(i * 12.5).toFixed(2)}`)
    await page.locator('input[type=file]').setInputFiles([{ name: 'sales.csv', mimeType: 'text/csv', buffer: Buffer.from(`id,region,sold_on,amount\n${rows.join('\n')}\n`) }])
    const starters = page.getByRole('navigation', { name: 'Example queries' })
    await expect(starters.getByRole('button')).toHaveText(['amount by region', 'amount per month', 'Top 10 by amount', 'Summary of every column', ''])
    await starters.getByRole('button', { name: 'amount by region' }).click()
    await expect(page.locator('.result-meta')).toContainText('3 rows')
    await expect(page.locator('.cm-content')).toContainText('round(sum(amount), 2) AS total_amount')
    // Still offered after running one, so they can be tried in turn.
    await starters.getByRole('button', { name: 'Summary of every column' }).click()
    await expect(page.locator('.result-meta')).toContainText('4 rows')
  })

  test('theme toggle overrides the system and persists; the canvas grid follows', async ({ page }) => {
    await openDemo(page)
    const html = page.locator('html')
    await expect(html).toHaveAttribute('data-theme', 'light')
    const toggle = page.getByRole('button', { name: /Colour theme/ })
    await toggle.click() // System → Light
    await toggle.click() // Light → Dark
    await expect(html).toHaveAttribute('data-theme', 'dark')
    const cornerRed = () =>
      page.locator('.grid-canvas').evaluate((c: HTMLCanvasElement) => c.getContext('2d')!.getImageData(c.width - 20, c.height - 20, 1, 1).data[0])
    await expect.poll(cornerRed).toBeLessThan(60)
    await page.reload()
    await expect(html).toHaveAttribute('data-theme', 'dark')
  })

  test('? opens the shortcut list, except while typing', async ({ page }) => {
    await openDemo(page)
    await page.locator('.grid-scroll').focus()
    await page.keyboard.press('Shift+Slash')
    await expect(page.getByRole('dialog', { name: 'Shortcuts' })).toBeVisible()
    // It's a list to read: focus starts on its heading, in view (Done is below the fold on short screens).
    await expect(page.getByRole('heading', { name: 'Shortcuts' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)

    await page.locator('.cm-content').click()
    await page.keyboard.type('?')
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })
})

test.describe('phone layout', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  test('tables live in a bottom sheet, SQL collapses, nothing scrolls sideways', async ({ page }) => {
    await openDemo(page)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
    await expect(page.locator('#sql-editor')).toBeHidden()

    await page.getByRole('button', { name: 'Tables' }).tap()
    const sheet = page.getByRole('dialog', { name: 'Tables, saved views and history' })
    await expect(sheet).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(sheet).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Tables' })).toBeFocused()

    await page.getByRole('button', { name: /Edit SQL/ }).tap()
    await expect(page.locator('#sql-editor')).toBeVisible()
  })
})
