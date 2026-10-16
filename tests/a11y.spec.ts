import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { openApp, openDemo } from './helpers'

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`accessibility (${colorScheme})`, () => {
    // axe is injected as a script, which the CSP would (correctly) block.
    test.use({ colorScheme, bypassCSP: true, reducedMotion: 'reduce' })

    test('landing has no WCAG A/AA violations', async ({ page }) => {
      await openApp(page)
      const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze()
      expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' ')}`)).toEqual([])
    })

    test('workspace, column menu and dialog have no violations', async ({ page }) => {
      await openDemo(page)
      await page.locator('.grid-scroll').focus()
      await page.keyboard.press('ArrowDown')
      let { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze()
      expect(violations.map((v) => v.id)).toEqual([])

      await page.keyboard.press('Alt+ArrowDown')
      await expect(page.locator('.topvals li').first()).toBeVisible()
      ;({ violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze())
      expect(violations.map((v) => v.id)).toEqual([])
      await page.keyboard.press('Escape')

      await page.getByRole('button', { name: 'Add column' }).click()
      ;({ violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze())
      expect(violations.map((v) => v.id)).toEqual([])
    })

    test('pivot dialog has no violations', async ({ page }) => {
      await openDemo(page)
      await page.getByRole('button', { name: 'Pivot', exact: true }).click()
      await expect(page.locator('.pivot-grid')).toBeVisible()
      const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze()
      expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' ')}`)).toEqual([])
    })

    test('shortcut list and phone sheet have no violations', async ({ page }) => {
      await openDemo(page)
      await page.getByRole('button', { name: 'Keyboard shortcuts' }).click()
      await expect(page.getByRole('dialog', { name: 'Shortcuts' })).toBeVisible()
      let { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze()
      expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' ')}`)).toEqual([])
      await page.keyboard.press('Escape')

      await page.setViewportSize({ width: 390, height: 844 })
      await page.getByRole('button', { name: 'Tables' }).click()
      await expect(page.getByRole('dialog', { name: 'Tables, saved views and history' })).toBeVisible()
      ;({ violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze())
      expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' ')}`)).toEqual([])
    })

    test('chart view has no violations', async ({ page }) => {
      await openDemo(page)
      await page.getByRole('button', { name: 'Chart', exact: true }).click()
      await expect(page.locator('.chart svg')).toBeVisible()
      await page.locator('.chart svg').focus()
      await page.keyboard.press('ArrowRight')
      const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze()
      expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(' ')}`)).toEqual([])
    })
  })
}

test.describe('keyboard and screen readers', () => {
  test('skip link, active cell, column menu and dialog focus', async ({ page }) => {
    await openDemo(page)
    await page.locator('body').click({ position: { x: 5, y: 5 } })
    await page.keyboard.press('Tab')
    await expect(page.locator(':focus')).toHaveText('Skip to results grid')
    await page.keyboard.press('Enter')
    await expect(page.locator('.grid-scroll')).toBeFocused()

    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    const active = await page.evaluate(() => {
      const id = document.querySelector('.grid-scroll')!.getAttribute('aria-activedescendant')
      const el = id ? document.getElementById(id) : null
      return { text: el?.textContent, row: el?.parentElement?.getAttribute('aria-rowindex'), col: el?.getAttribute('aria-colindex') }
    })
    expect(active).toEqual({ text: 'Diya Smith', row: '3', col: '3' })

    await page.keyboard.press('Alt+ArrowDown')
    await expect(page.locator('.colmenu')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('.grid-scroll')).toBeFocused()

    await page.getByRole('button', { name: 'Add column' }).click()
    for (let i = 0; i < 25; i++) await page.keyboard.press('Tab')
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role=dialog]'))).toBe(true)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: 'Add column' })).toBeFocused()
  })

  test('the SQL editor does not trap Tab', async ({ page }) => {
    await openDemo(page)
    await page.locator('.cm-content').click()
    await page.keyboard.press('Tab')
    expect(await page.evaluate(() => !!document.activeElement?.closest('.cm-editor'))).toBe(false)
  })
})
