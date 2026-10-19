import { expect, test } from './fixtures'

/*
 * The landing page's two line figures: the hero's sheet that rises into a chart, and the tidy band's belt.
 * They load after the page, answer the pointer with a line of SQL, and stay off small screens.
 */

/** Moves the pointer to a point of a figure's 400 × 320 drawing. */
async function pointAt(page: import('@playwright/test').Page, stage: string, x: number, y: number) {
  const box = (await page.locator(stage).boundingBox())!
  await page.mouse.move(box.x + (box.width * x) / 400, box.y + (box.height * y) / 320)
}

test.describe('landing figures', () => {
  test('the hero sheet answers the column under the pointer in SQL, and lets go', async ({ page }) => {
    await page.goto('/')
    const hero = page.locator('.hero-figure')
    await expect(hero.locator('svg path').first()).toBeAttached()
    await pointAt(page, '.hero-figure .hfig-stage', 210, 150)
    await expect(hero.locator('.hfig-read')).toHaveText('SELECT SUM(D) 30,080')
    await expect(hero.locator('.hfig-read')).toHaveClass(/is-on/)
    await page.mouse.move(5, 5)
    await expect(hero.locator('.hfig-read')).not.toHaveClass(/is-on/)
  })

  test('the tidy belt names the fix under the pointer', async ({ page }) => {
    await page.goto('/')
    await page.locator('.tidy-band').scrollIntoViewIfNeeded()
    const read = page.locator('.tidy-core .hfig-read')
    await expect(page.locator('.tidy-core svg path').first()).toBeAttached()
    await pointAt(page, '.tidy-core .hfig-stage', 193, 138)
    await expect(read).toHaveText('FROM Sheet1')
  })

  test('phones get no hero figure, and nothing is loaded for it', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(page.locator('.hero-figure')).toBeHidden()
    await expect(page.locator('.hero-figure svg')).toHaveCount(0)
  })
})
