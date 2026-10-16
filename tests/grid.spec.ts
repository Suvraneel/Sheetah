import { expect, test } from '@playwright/test'
import { gridTop, metaText, openDemo, runSql } from './helpers'

test.describe('grid and query engine', () => {
  test('1M-row demo scrolls at ~60 fps and reaches the last row @perf', async ({ page }) => {
    await openDemo(page)
    const frames = await page.evaluate(async () => {
      const s = document.querySelector('.grid-scroll') as HTMLElement
      const max = s.scrollHeight - s.clientHeight
      const t: number[] = []
      let last = performance.now()
      for (let i = 0; i <= 120; i++) {
        s.scrollTop = max * (i / 120)
        await new Promise((r) => requestAnimationFrame(() => r(null)))
        const now = performance.now()
        t.push(now - last)
        last = now
      }
      t.sort((a, b) => a - b)
      return { median: t[60], p95: t[114] }
    })
    // Run alone (`npm run test:perf`, one worker): frame timing is meaningless while other tests share the CPU.
    // Generous bound so slow CI machines don't flake; locally this is ~16.7 ms median.
    expect(frames.median).toBeLessThan(40)

    const top = await gridTop(page)
    await page.mouse.click(700, top + 120)
    await page.keyboard.press('ControlOrMeta+ArrowDown')
    await expect(page.locator('.statusbar')).toContainText('Row 1,000,000')
  })

  test('10M-row result uses the proportional scrollbar', async ({ page }) => {
    await openDemo(page)
    await runSql(page, 'SELECT range AS n, range * 2 AS twice FROM range(10000000)')
    await expect(page.locator('.result-meta')).toContainText('10,000,000 rows')
    const top = await gridTop(page)
    await page.mouse.click(600, top + 80)
    await page.keyboard.press('ControlOrMeta+ArrowDown')
    await expect(page.locator('.statusbar')).toContainText('Row 10,000,000')
    await expect(page.locator('.statusbar')).toContainText('19999998')
  })

  test('range selection shows SQL-computed stats and copies TSV', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await openDemo(page)
    const top = await gridTop(page)
    const quantityX = 1250 // the quantity column in the default 1440px layout
    await page.mouse.click(quantityX, top + 60)
    await page.keyboard.down('Shift')
    await page.mouse.click(quantityX, top + 340)
    await page.keyboard.up('Shift')
    await expect(page.locator('.status-stats')).toContainText('Count 10')
    await page.keyboard.press('ControlOrMeta+c')
    await expect(page.locator('.toast')).toContainText('Copied 10 cells')
    const clip = await page.evaluate(() => navigator.clipboard.readText())
    expect(clip.split('\n')).toHaveLength(11) // header + 10 rows
  })

  test('header menu: filter from top values, sort, formula column', async ({ page }) => {
    await openDemo(page)
    const top = await gridTop(page)
    await page.mouse.click(860, top + 20) // city
    await expect(page.locator('.colmenu')).toBeVisible()
    await expect(page.locator('.topvals li').first()).toBeVisible()
    await page.locator('.topvals li').first().click()
    await expect(page.locator('.op-chips')).toContainText('city =')
    const filtered = Number((await metaText(page)).split(' ')[0].replace(/,/g, ''))
    expect(filtered).toBeGreaterThan(50_000)
    expect(filtered).toBeLessThan(100_000)

    await page.mouse.click(860, top + 20)
    await page.locator('.colmenu-actions .seg').nth(1).click()
    await expect(page.locator('.op-chips')).toContainText('city')

    await page.getByRole('button', { name: 'Add column' }).click()
    await page.fill('#col-name', 'revenue_k')
    await page.fill('#col-expr', 'round(total / 1000, 1)')
    await page.locator('.modal .btn-primary').click()
    await expect(page.locator('.result-meta')).toContainText('12 columns')
    await expect(page.locator('.cm-content')).toContainText('AS "revenue_k"')
  })

  test('SQL errors are shown with DuckDB’s message', async ({ page }) => {
    await openDemo(page)
    await runSql(page, 'SELEC nope FROM orders')
    await expect(page.locator('.error-banner')).toContainText('syntax error')
  })

  test('long queries can be cancelled', async ({ page }) => {
    await openDemo(page)
    // ~900M row evaluations: seconds of CPU, almost no memory
    await runSql(page, 'SELECT count(*) FROM range(30000) a, range(30000) b WHERE (a.range * b.range) % 7 = 3')
    const cancel = page.getByRole('button', { name: 'Cancel' })
    await expect(cancel).toBeVisible()
    await cancel.click()
    await expect(page.locator('.toast, .error-banner')).toContainText(/cancel/i)
    await runSql(page, 'SELECT 42 AS answer')
    await expect(page.locator('.result-meta')).toContainText('1 rows')
  })
})
