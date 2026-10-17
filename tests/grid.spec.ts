import { expect, test } from './fixtures'
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
    await expect(page.locator('.statusbar')).toContainText('19,999,998') // as the cell shows it
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
    await expect(page.locator('.toast', { hasText: 'Copied 10 cells' })).toBeVisible()
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
    await expect(page.locator('.result-meta')).toContainText('of 1,000,000 rows') // the filtered result is in
    const filtered = Number((await metaText(page)).split(' ')[0].replace(/,/g, ''))
    expect(filtered).toBeGreaterThan(50_000)
    expect(filtered).toBeLessThan(100_000)

    await page.mouse.click(860, (await gridTop(page)) + 20) // the toolbar may have grown a line of chips
    await page.locator('.colmenu-actions .seg').nth(1).click()
    await expect(page.locator('.op-chips')).toContainText('city')

    await page.getByRole('button', { name: 'Add column' }).click()
    await page.fill('#col-name', 'revenue_k')
    await page.fill('#col-expr', 'round(total / 1000, 1)')
    await page.locator('.modal .btn-primary').click()
    await expect(page.locator('.result-meta')).toContainText('12 columns')
    await expect(page.locator('.cm-content')).toContainText('AS "revenue_k"')
  })

  test('the first column stays in view while a wide table scrolls sideways', async ({ page }) => {
    await openDemo(page)
    const months = Array.from({ length: 24 }, (_, i) => `range * ${i + 1} AS m${String(i + 1).padStart(2, '0')}`).join(', ')
    await runSql(page, `SELECT 'branch ' || range AS branch, ${months} FROM range(50)`)
    await expect(page.locator('.result-meta')).toContainText('50 rows · 25 columns')
    const grid = page.locator('.grid-scroll')
    await grid.evaluate((el) => (el.scrollLeft = el.scrollWidth))
    const box = (await grid.boundingBox())!
    // Scrolled all the way right, the far-left strip is still the branch column: clicking it selects branch.
    await page.mouse.click(box.x + 90, box.y + 44 + 30 * 2 + 15)
    await expect(page.locator('.statusbar')).toContainText('branch 2')
    // Moving down the pinned column keeps the view where it is, and screen readers have the cell too.
    const scrolled = await grid.evaluate((el) => el.scrollLeft)
    await page.keyboard.press('ArrowDown')
    await expect(page.locator('.statusbar')).toContainText('branch 3')
    expect(await grid.evaluate((el) => el.scrollLeft)).toBe(scrolled)
    await expect(page.locator('.sr-grid [role=columnheader]').first()).toContainText('branch')
    const active = await grid.getAttribute('aria-activedescendant')
    await expect(page.locator(`[id="${active}"]`)).toHaveText('branch 3')
    // Its header opens branch's menu.
    await page.mouse.click(box.x + 90, box.y + 20)
    await expect(page.locator('.colmenu-head')).toContainText('branch')
    await page.keyboard.press('Escape')
    // Keyboard: moving left from the last column brings columns out from under it, not behind it.
    await grid.focus()
    await page.keyboard.press('End')
    await page.keyboard.press('ControlOrMeta+ArrowLeft')
    await page.keyboard.press('ArrowRight')
    await expect(page.locator('.statusbar')).toContainText('m01')
    expect(await grid.evaluate((el) => el.scrollLeft)).toBe(0)
  })

  test('Shift+Space selects the row, Ctrl+Space the column, and the active cell is always in the mirror', async ({ page }) => {
    await openDemo(page)
    const grid = page.locator('.grid-scroll')
    await grid.focus()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Shift+Space')
    await expect(page.locator('.status-stats')).toContainText('Count 11')
    // Real column names: a selected row isn't offered as names (that's for files whose names were missed).
    await expect(page.locator('.statusbar').getByRole('button', { name: 'Use row 3 as column names' })).toHaveCount(0)
    let active = await grid.getAttribute('aria-activedescendant')
    await expect(page.locator(`[id="${active}"]`)).toHaveCount(1)
    await page.keyboard.press('Control+Space')
    await expect(page.locator('.status-stats')).toContainText('Count 1,000,000')
    active = await grid.getAttribute('aria-activedescendant')
    await expect(page.locator(`[id="${active}"]`)).toHaveCount(1)
  })

  test('SQL errors are explained, with DuckDB’s message under Details', async ({ page }) => {
    await openDemo(page)
    await runSql(page, 'SELEC nope FROM orders')
    await expect(page.locator('.error-banner')).toContainText('SQL couldn’t be read at “SELEC”')
    await page.locator('.error-banner summary').click()
    await expect(page.locator('.error-detail code')).toContainText('syntax error at or near "SELEC"')
    // Text in double quotes, and a table that isn't there: said in the user's terms, with their tables.
    await runSql(page, 'SELECT * FROM orders WHERE city = "Pune"')
    await expect(page.locator('.error-banner')).toContainText('Put text in single quotes: \'Pune\'')
    // One click puts it right and runs it.
    await page.locator('.error-banner').getByRole('button', { name: "Use 'Pune'" }).click()
    await expect(page.locator('.cm-content')).toContainText("city = 'Pune'")
    await expect(page.locator('.error-banner')).toHaveCount(0)
    await expect(page.locator('.result-meta')).not.toContainText('1,000,000 rows') // only Pune's
    await runSql(page, 'SELECT * FROM xyzzy')
    await expect(page.locator('.error-banner')).toContainText('There’s no table called “xyzzy”. Your tables: orders')
    // No error at all, but a slip: two column names with no comma between them.
    await runSql(page, 'SELECT city customer FROM orders LIMIT 5')
    const slip = page.locator('.toast', { hasText: 'customer here is city renamed' })
    await slip.getByRole('button', { name: 'Add the comma' }).click()
    await expect(page.locator('.cm-content')).toContainText('SELECT city, customer FROM orders')
    await expect(page.locator('.result-meta')).toContainText('5 rows · 2 columns')
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
