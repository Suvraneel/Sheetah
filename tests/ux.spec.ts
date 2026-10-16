import { expect, test } from '@playwright/test'
import { openDemo } from './helpers'

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
