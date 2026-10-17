import { expect, test, type Page } from './fixtures'
import { openApp, openDemo, runSql } from './helpers'

const file = (name: string, text: string) => ({ name, mimeType: 'text/csv', buffer: Buffer.from(text) })

/** Waits until no query is running (header actions show their chips at once; the result follows). */
const idle = (page: Page) => expect(page.getByRole('button', { name: 'Run query' })).toBeVisible({ timeout: 60_000 })

async function columnMenu(page: Page, column: number) {
  await page.locator('.grid-scroll').focus()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Home') // from the first column, wherever the active cell was
  for (let i = 0; i < column; i++) await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Alt+ArrowDown')
  await expect(page.locator('.colmenu')).toBeVisible()
}

test.describe('everyday workflows', () => {
  test('find text in every column with Ctrl/⌘+F, and see how many rows matched', async ({ page }) => {
    await openDemo(page)
    await page.locator('.grid-scroll').focus()
    await page.keyboard.press('ControlOrMeta+f')
    await page.getByLabel('Find in every column').fill('kenji tanaka')
    await page.keyboard.press('Enter')
    await expect(page.locator('.op-chip')).toContainText('Contains “kenji tanaka”')
    // A find over every column of a million rows: give a busy test machine time.
    await expect(page.locator('.result-meta')).toContainText('of 1,000,000 rows', { timeout: 60_000 })
    const n = Number((await page.locator('.result-meta strong').innerText()).replace(/,/g, ''))
    expect(n).toBeGreaterThan(1000)
    expect(n).toBeLessThan(20_000)
  })

  test('duplicates: show the repeats, or keep the first of each', async ({ page }) => {
    await openApp(page)
    await page.locator('input[type=file]').setInputFiles([file('signups.csv', 'id,email\n1,a@x.com\n2,b@x.com\n3,a@x.com\n4,c@x.com\n5,b@x.com\n')])
    await expect(page.locator('.result-meta')).toContainText('5 rows')
    await columnMenu(page, 1)
    await expect(page.locator('.colmenu-dupes')).toContainText('2 rows repeat a value')
    await page.getByRole('button', { name: 'Show duplicates' }).click()
    await expect(page.locator('.result-meta')).toContainText('4 of 5 rows')
    await page.locator('.op-chip', { hasText: 'Duplicates in email' }).click()
    await expect(page.locator('.result-meta')).toContainText('5 rows')
    await columnMenu(page, 1)
    await page.getByRole('button', { name: 'Keep first of each' }).click()
    await expect(page.locator('.result-meta')).toContainText('3 of 5 rows')
    await expect(page.locator('.sr-grid [role=row]').nth(1)).toContainText('1')
    await expect(page.locator('.sr-grid [role=row]').nth(3)).toContainText('4') // original order kept
  })

  test('header actions never silently discard SQL you edited but didn’t run', async ({ page }) => {
    await openDemo(page)
    await page.locator('.cm-content').click()
    await page.keyboard.press('ControlOrMeta+End')
    await page.keyboard.insertText(" WHERE city = 'Pune'")
    await page.keyboard.press('Escape')
    await columnMenu(page, 9)
    await page.getByRole('button', { name: /High → low/ }).click()
    await expect(page.locator('.edit-guard')).toContainText('You’ve edited the SQL but haven’t run it')
    await expect(page.locator('.cm-content')).toContainText("city = 'Pune'")
    await page.getByRole('button', { name: 'Run my edits' }).click()
    await expect(page.locator('.edit-guard')).toHaveCount(0)
    await expect(page.locator('.result-meta strong')).not.toHaveText('1,000,000')
    // Once run, sorting works on top of it.
    await columnMenu(page, 9)
    await page.getByRole('button', { name: /High → low/ }).click()
    await expect(page.locator('.cm-content')).toContainText('ORDER BY total DESC')
    await expect(page.locator('.cm-content')).toContainText("city = 'Pune'")
  })

  test('multi-select Ctrl+A copy says when it was cut short', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await openDemo(page)
    await page.locator('.grid-scroll').focus()
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.press('ControlOrMeta+c')
    await expect(page.locator('.toast', { hasText: 'Copied the first 50,000 rows. Use Export for all 1,000,000.' })).toBeVisible()
    await runSql(page, 'SELECT 1 AS a')
  })
})

test.describe('cleaning columns', () => {
  test('numbers stored as text are offered as one click; columns can be trimmed, re-cased and restored', async ({ page }) => {
    await openApp(page)
    await page
      .locator('input[type=file]')
      .setInputFiles([file('invoices.csv', 'invoice,city,amount,pin\n1,"  pune ",₹950,"011001"\n2,Goa,"₹1,200","560034"\n3,"delhi","₹10,000","400001"\n')])
    await expect(page.locator('.result-meta')).toContainText('3 rows')
    // amount is text because of the ₹ and commas; pin looks numeric but is a code, so it is left alone.
    const offer = page.getByRole('button', { name: 'Convert 1 text column to numbers' })
    await expect(offer).toBeVisible()
    // Its header says which column the suggestion is about.
    await expect(page.locator('.sr-grid [role=columnheader]').nth(2)).toHaveText('amount, number as text')
    await offer.click()
    await expect(page.locator('.cm-content')).toContainText('SELECT * REPLACE (')
    await expect(page.locator('.op-chip', { hasText: 'amount as number' })).toBeVisible()
    await idle(page)
    await columnMenu(page, 2)
    await expect(page.locator('.colmenu-profile dl')).toContainText('12,150') // the sum: it's a number now
    await expect(page.locator('.colmenu-clean')).toContainText('Cleaned: as number')
    await page.keyboard.press('Escape')

    await columnMenu(page, 1)
    await page.getByRole('button', { name: 'Trim extra spaces' }).click()
    await expect(page.locator('.op-chip', { hasText: 'city trimmed' })).toBeVisible()
    await idle(page)
    await columnMenu(page, 1)
    await expect(page.locator('.colmenu-clean')).toContainText('Cleaned: trimmed')
    await page.locator('.colmenu-clean').getByRole('button', { name: 'Undo' }).click()
    await expect(page.locator('.op-chip', { hasText: 'city trimmed' })).toHaveCount(0)
    await idle(page)
    await columnMenu(page, 1)
    await page.getByRole('button', { name: 'Title' }).click()
    await expect(page.locator('.sr-grid [role=row]').nth(1)).toContainText('Pune')
    await expect(page.locator('.sr-grid [role=row]').nth(3)).toContainText('Delhi')
    await expect(page.locator('.error-banner')).toHaveCount(0)
  })
})

test.describe('look up', () => {
  test('brings columns from another table by a matching column, keeping every row once', async ({ page }) => {
    await openApp(page)
    await page.locator('input[type=file]').setInputFiles([
      file('products.csv', 'SKU,product,price\nA-1,Lamp,500\nB-2,Mug,120\nA-1,Lamp v2,550\n'),
      file('sales.csv', 'id,sku,qty\n1,a-1,2\n2,B-2,1\n3,Z-9,5\n'),
    ])
    await expect(page.locator('.result-meta')).toContainText('3 rows') // products, opened first
    await page.locator('.side-table', { hasText: 'sales' }).click()
    await expect(page.locator('.cm-content')).toContainText('FROM sales')
    // The editor changes first; the grid's rows (and its selection) once the query is back.
    await expect(page.locator('.sr-grid [role=columnheader]').nth(1)).toContainText('sku')
    await columnMenu(page, 1)
    await page.getByRole('button', { name: /Look up values by “sku”/ }).click()
    const dialog = page.getByRole('dialog', { name: 'Bring in columns from another table' })
    await expect(dialog.getByLabel('From table')).toHaveValue('products')
    await expect(dialog.getByLabel('with its column')).toHaveValue('SKU') // matched by name, ignoring case
    await expect(dialog.locator('.lookup-stats')).toContainText('2 of 3 rows find a match (67%)')
    await expect(dialog.locator('.lookup-stats')).toContainText('1 value repeats in products: the first row is used')
    await expect(dialog.locator('.lookup-stats')).toContainText('Not in products: Z-9 (1 row).')
    await dialog.getByRole('button', { name: 'Bring 2 columns' }).click()
    await expect(page.locator('.result-meta')).toContainText('3 rows · 5 columns')
    await expect(page.locator('.op-chip', { hasText: 'product, price from products' })).toBeVisible()
    await expect(page.locator('.cm-content')).toContainText('LEFT JOIN')
    await expect(page.locator('.sr-grid [role=row]').nth(1)).toContainText('Lamp')
    await expect(page.locator('.error-banner')).toHaveCount(0)
  })
})

test.describe('undo', () => {
  test('header actions can be undone and redone, from the toolbar or the keyboard', async ({ page }) => {
    await openDemo(page)
    await columnMenu(page, 3) // city
    await page.locator('.topvals li').first().click()
    await expect(page.locator('.op-chips')).toContainText('city =')
    await idle(page)
    await columnMenu(page, 9) // total
    await page.getByRole('button', { name: /High → low/ }).click()
    await expect(page.locator('.cm-content')).toContainText('ORDER BY total DESC')
    await idle(page)

    await page.locator('.op-chips').getByRole('button', { name: 'Undo' }).click()
    await expect(page.locator('.cm-content')).not.toContainText('ORDER BY total DESC')
    await expect(page.locator('.op-chips')).toContainText('city =')
    await expect(page.getByRole('button', { name: 'Run query' })).toBeVisible()
    await page.locator('.grid-scroll').focus()
    await page.keyboard.press('ControlOrMeta+z')
    await expect(page.locator('.op-chips')).not.toContainText('city =')
    await idle(page)
    await expect(page.locator('.result-meta')).toContainText('1,000,000 rows')
    await page.keyboard.press('ControlOrMeta+Shift+z')
    await expect(page.locator('.op-chips')).toContainText('city =')
    await idle(page)
    await page.locator('.op-chips').getByRole('button', { name: 'Redo' }).click()
    await expect(page.locator('.cm-content')).toContainText('ORDER BY total DESC')
    await idle(page)

    // "Count rows by" starts a new query from these rows; Undo comes back to them.
    await columnMenu(page, 5) // product
    await page.getByRole('button', { name: /Count rows by “product”/ }).click()
    await expect(page.locator('.cm-content')).toContainText('GROUP BY product')
    await idle(page)
    await page.locator('.grid-scroll').focus()
    await page.keyboard.press('ControlOrMeta+z')
    await expect(page.locator('.cm-content')).toContainText('ORDER BY total DESC')
    await expect(page.locator('.op-chips')).toContainText('city =')
    // Redo, and the counted rows say what they came from, with a way back that keeps the steps.
    await idle(page)
    await page.keyboard.press('ControlOrMeta+Shift+z')
    await expect(page.locator('.origin-chip')).toHaveText('Rows counted by product, from orders')
    await page.locator('.origin-chip').click()
    await expect(page.locator('.op-chips')).toContainText('city =')
    await expect(page.locator('.origin-chip')).toHaveCount(0)
  })
})

test.describe('stack', () => {
  test('several exports of one kind are offered as one stacked table', async ({ page }) => {
    await openApp(page)
    await page.locator('input[type=file]').setInputFiles([
      file('sales_jan.csv', 'id,city,amount\n1,Pune,10\n2,Goa,20\n'),
      file('sales_feb.csv', 'city,id,amount\nAgra,3,30\n'),
      file('sales_mar.csv', 'id,city,amount,channel\n4,Pune,40,web\n'),
    ])
    await page.getByRole('button', { name: 'Stack them' }).click()
    const dialog = page.getByRole('dialog', { name: 'Stack tables into one' })
    await expect(dialog.locator('.stack-report')).toContainText('4 rows · 5 columns. Not in every table (empty where missing): channel.')
    await dialog.getByRole('button', { name: 'Stack 3 tables' }).click()
    await expect(page.locator('.result-meta')).toContainText('4 rows · 5 columns')
    await expect(page.locator('.cm-content')).toContainText('UNION ALL BY NAME')
    await expect(page.locator('.sr-grid [role=columnheader]').first()).toContainText('source')
    await expect(page.locator('.error-banner')).toHaveCount(0)
  })
})

test.describe('fill down', () => {
  test('a report that names each group once gets the name on every row', async ({ page }) => {
    await openApp(page)
    await page.locator('input[type=file]').setInputFiles([file('report.csv', 'region,month,sales\nNorth,Jan,10\n,Feb,12\n,Mar,9\nSouth,Jan,7\n,Feb,8\n')])
    await expect(page.locator('.result-meta')).toContainText('5 rows')
    await columnMenu(page, 0)
    await page.getByRole('button', { name: 'Fill empty cells with the value above' }).click()
    await expect(page.locator('.op-chip', { hasText: 'region filled down' })).toBeVisible()
    await idle(page)
    await expect(page.locator('.sr-grid [role=row]').nth(3)).toContainText('North')
    await expect(page.locator('.sr-grid [role=row]').nth(5)).toContainText('South')
    await expect(page.locator('.error-banner')).toHaveCount(0)
  })
})

test.describe('columns from a column', () => {
  test('date parts and split pieces become formula columns', async ({ page }) => {
    await openApp(page)
    await page.locator('input[type=file]').setInputFiles([file('people.csv', 'name,joined,place\nAsha Rao,2024-03-15,"Pune, MH"\nRavi K,2023-11-02,"Goa, GA"\n')])
    await expect(page.locator('.result-meta')).toContainText('2 rows')
    await columnMenu(page, 1) // joined (a date)
    await page.getByRole('group', { name: 'Add columns from this one' }).getByRole('button', { name: 'Month' }).click()
    await expect(page.locator('.op-chips')).toContainText('joined_month')
    await idle(page)
    await expect(page.locator('.sr-grid [role=row]').nth(1)).toContainText('2024-03')
    await columnMenu(page, 2) // place
    await page.getByLabel('Split into columns at').fill(',')
    await page.getByRole('group', { name: 'Add columns from this one' }).getByRole('button', { name: 'Split' }).click()
    await expect(page.locator('.op-chips')).toContainText('place_2')
    await idle(page)
    await expect(page.locator('.sr-grid [role=row]').nth(1)).toContainText('MH')
    await expect(page.locator('.error-banner')).toHaveCount(0)
  })
})

test.describe('replace a value', () => {
  test('a misspelt category is merged into the right one, and the count says so', async ({ page }) => {
    await openApp(page)
    await page.locator('input[type=file]').setInputFiles([file('cities.csv', 'city,sales\nBengaluru,10\nBangalore,12\nPune,9\nBangalore ,7\nN/A,1\n')])
    await expect(page.locator('.result-meta')).toContainText('5 rows')
    await columnMenu(page, 0)
    await page.getByLabel('Value to replace').fill('bangalore') // case doesn't matter
    await page.getByLabel('Replace with').fill('Bengaluru')
    await page.getByRole('button', { name: 'Replace', exact: true }).click()
    await expect(page.locator('.op-chip', { hasText: 'city “bangalore” → “Bengaluru”' })).toBeVisible()
    await idle(page)
    await columnMenu(page, 0)
    await expect(page.locator('.topvals li').first()).toContainText('Bengaluru3')
    await page.getByLabel('Value to replace').fill('N/A')
    await page.getByRole('button', { name: 'Replace', exact: true }).click()
    await expect(page.locator('.op-chip', { hasText: 'city “N/A” → empty' })).toBeVisible()
    await idle(page)
    await expect(page.locator('.cm-content')).toContainText("CASE WHEN lower(trim(city)) = lower('N/A') THEN NULL ELSE city END")
  })

  test('one value written two ways is offered for merging into the common spelling', async ({ page }) => {
    await openApp(page)
    const rows = ['Hyderabad', 'Hyderabad', 'Hyderabad', 'Hyderabad', 'Hyderabad', 'Hydrabad', 'Pune', 'Pune'].map((c, i) => `${c},${i}`).join('\n')
    await page.locator('input[type=file]').setInputFiles([file('branches.csv', `branch,sales\n${rows}\n`)])
    await expect(page.locator('.result-meta')).toContainText('8 rows')
    await columnMenu(page, 0)
    await page.locator('.colmenu-alike').getByRole('button', { name: 'Hydrabad → Hyderabad' }).click()
    await expect(page.locator('.op-chip', { hasText: 'branch “Hydrabad” → “Hyderabad”' })).toBeVisible()
    await idle(page)
    await columnMenu(page, 0)
    await expect(page.locator('.topvals li').first()).toContainText('Hyderabad6')
    await expect(page.locator('.colmenu-alike')).toHaveCount(0)
  })
})

test.describe('rows that are not data', () => {
  test('a report’s total line and empty rows are offered for leaving out', async ({ page }) => {
    await openApp(page)
    await page.locator('input[type=file]').setInputFiles([file('totals.csv', 'region,month,sales\nNorth,Jan,10\n,,\nSouth,Jan,7\nTotal,,17\n')])
    await expect(page.locator('.result-meta')).toContainText('4 rows')
    const hint = page.getByRole('button', { name: 'Leave out 1 total line and 1 empty row' })
    await hint.click()
    await expect(page.locator('.result-meta')).toContainText('2 of 4 rows')
    await expect(hint).toHaveCount(0)
    await page.locator('.op-chip', { hasText: 'Without 1 total line' }).click()
    await expect(page.locator('.result-meta')).toContainText('3 of 4 rows')
    await idle(page)
    await page.keyboard.press('ControlOrMeta+z')
    await expect(page.locator('.result-meta')).toContainText('2 of 4 rows')
  })

  test('an empty first column doesn’t hide the total line in the next, and is offered for hiding', async ({ page }) => {
    await openApp(page)
    await page.locator('input[type=file]').setInputFiles([file('spacer.csv', ',region,amount\n,North,1200\n,South,800\n,East,500\n,West,300\n,Total,2800\n')])
    await expect(page.locator('.result-meta')).toContainText('5 rows')
    // Nothing empty on the Total line (once the empty column is set aside): trusted because it adds up.
    await page.getByRole('button', { name: 'Leave out 1 total line' }).click()
    await expect(page.locator('.result-meta')).toContainText('4 of 5 rows')
    await idle(page)
    await page.getByRole('button', { name: 'Hide 1 empty column' }).click()
    await expect(page.locator('.result-meta')).toContainText('2 columns')
    await expect(page.getByRole('button', { name: 'Hide 1 empty column' })).toHaveCount(0)
  })
})

test.describe('hints follow their table', () => {
  test('a table opened again from the list gets its suggestions back; one opened for the first time is looked over', async ({ page }) => {
    await openApp(page)
    // Two files at once: only the first is shown, and looked over, on opening.
    await page.locator('input[type=file]').setInputFiles([
      file('plain.csv', 'a,b\n1,2\n'),
      file('report.csv', 'region,rep,sales\nNorth,Asha,"₹1,200"\nSouth,Ravi,"₹800"\nTotal,,"₹2,000"\n'),
    ])
    await expect(page.locator('.result-meta')).toContainText('1 rows')
    await page.locator('.side-table', { hasText: 'report' }).click()
    await expect(page.getByRole('button', { name: 'Leave out 1 total line' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Convert 1 text column to numbers' })).toBeVisible()
    await page.locator('.side-table', { hasText: 'plain' }).click()
    await expect(page.locator('.result-meta')).toContainText('1 rows')
    await expect(page.locator('.hint-chips')).toHaveCount(0)
    await page.locator('.side-table', { hasText: 'report' }).click()
    await expect(page.getByRole('button', { name: 'Leave out 1 total line' })).toBeVisible()
  })
})

test.describe('the messy sample', () => {
  test('opens from the landing page and tidies up in three clicks', async ({ page }) => {
    await openApp(page)
    await page.getByRole('button', { name: 'Or tidy up a messy sales export' }).click()
    await expect(page.locator('.result-meta')).toContainText('23 rows')
    await page.getByRole('button', { name: 'Leave out 4 total lines and 3 empty rows' }).click()
    // Tied out: the sub-totals and the Grand Total add up to the invoices, so nothing's lost.
    await expect(page.locator('.toast', { hasText: 'Checked: the total lines add up to the rows left. Invoice Total comes to 721,' })).toBeVisible()
    await expect(page.locator('.result-meta')).toContainText('16 of 23 rows')
    await idle(page)
    await page.getByRole('button', { name: /^Convert 4 text columns to numbers and dates/ }).click()
    await expect(page.locator('.op-chip', { hasText: 'Taxable Value as number' })).toBeVisible()
    await expect(page.locator('.toast', { hasText: 'Save these steps as a view' })).toBeVisible()
    await idle(page)
    // Names typed with stray spaces (" asha rao ") are offered for tidying too.
    await expect(page.locator('.hint-chips').getByRole('button', { name: 'Tidy spaces in Customer' })).toBeVisible()
    // Region is named once per group: offered too, and gone once it's done.
    await page.locator('.hint-chips').getByRole('button', { name: 'Fill down Region' }).click()
    await idle(page)
    await expect(page.locator('.sr-grid [role=row]').nth(2)).toContainText('North')
    await expect(page.locator('.op-chip', { hasText: 'Region filled down' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Fill down Region' })).toHaveCount(0)
    // GST % was "18%" text: it shows as 18%, and a filter typed as a percentage means one.
    await expect(page.locator('.sr-grid [role=row]').nth(1)).toContainText('18%')
    await page.locator('.toast', { hasText: 'Save these steps' }).getByRole('button', { name: 'Dismiss' }).click()
    await columnMenu(page, 6)
    await page.getByLabel('Filter value').fill('12')
    await page.locator('.colmenu').getByRole('button', { name: 'Filter' }).click()
    await expect(page.locator('.op-chip', { hasText: 'GST % > 12%' })).toBeVisible()
    await expect(page.locator('.result-meta')).toContainText('9 of 23 rows')
    await expect(page.locator('.error-banner')).toHaveCount(0)
    // SQL typed against the file reads it as it is: offered the tidied rows instead.
    await runSql(page, 'SELECT sum("Taxable Value") AS taxable FROM sales_register_april')
    await expect(page.locator('.error-banner')).toContainText('needs numbers')
    const offer = page.locator('.toast', { hasText: 'without its 7 tidy-up steps' })
    await offer.getByRole('button', { name: 'Run on the tidied rows' }).click()
    await expect(page.locator('.cm-content')).toContainText('WITH sales_register_april AS (')
    await expect(page.locator('.result-meta')).toContainText('1 rows')
    await expect(page.locator('.sr-grid [role=row]').nth(1)).toContainText('613,950') // the invoices, not the totals too
    await expect(page.locator('.error-banner')).toHaveCount(0)
  })
})

test.describe('unpivot', () => {
  test('a report with one column per month becomes one row per month, and Undo brings it back', async ({ page }) => {
    await openApp(page)
    // April hasn't happened yet: an empty column, which the file reader takes for text.
    await page.locator('input[type=file]').setInputFiles([file('monthly.csv', 'region,Jan-24,Feb-24,Mar-24,Apr-24\nNorth,10,12,,\nSouth,7,8,9,\n')])
    await expect(page.locator('.result-meta')).toContainText('2 rows')
    await page.getByRole('button', { name: 'Turn 4 month columns into rows' }).click()
    const dialog = page.getByRole('dialog', { name: 'Turn columns into rows' })
    await expect(dialog.getByLabel('Column for their names')).toHaveValue('month')
    await expect(dialog.getByRole('status')).toContainText('2 rows × 4 columns → up to 8 rows')
    await dialog.getByRole('button', { name: 'Turn 4 columns into rows' }).click()
    await expect(page.locator('.result-meta')).toContainText('5 rows · 3 columns') // empty cells are left out
    await expect(page.locator('.sr-grid [role=columnheader]').nth(2)).toContainText('value, number') // still numbers
    // The month names are text now: offered as dates, so they sort and chart in time order.
    await expect(page.getByRole('button', { name: 'Convert 1 text column to dates' })).toBeVisible()
    await expect(page.locator('.cm-content')).toContainText('UNPIVOT')
    await expect(page.locator('.origin-chip')).toHaveText('Columns turned into rows, from monthly')
    await expect(page.locator('.sr-grid [role=columnheader]').nth(1)).toContainText('month')
    await idle(page)
    await page.keyboard.press('ControlOrMeta+z')
    await expect(page.locator('.result-meta')).toContainText('2 rows · 5 columns')
  })
})

test.describe('column names on a later row', () => {
  test('a row picked by its number becomes the column names, and Undo brings the file back', async ({ page }) => {
    await openApp(page)
    // Title lines padded to the full width: the file reader takes them for data.
    await page.locator('input[type=file]').setInputFiles([file('padded.csv', 'Sales report,,\nApril 2024,,\nInvoice,Customer,Amount\nINV-1,Asha,"1,200"\nINV-2,Ravi,800\nTotal,,"2,000"\n')])
    await expect(page.locator('.result-meta')).toContainText('5 rows')
    // Most columns got made-up names, and row 2 is all words: offered.
    await page.locator('.hint-chips').getByRole('button', { name: 'Use row 2 as column names' }).click()
    await expect(page.locator('.result-meta')).toContainText('3 rows · 3 columns')
    await expect(page.locator('.sr-grid [role=columnheader]').first()).toContainText('Invoice')
    await expect(page.locator('.cm-content')).toContainText('-- Row 2 as the column names')
    // Now it's looked over like any table: the total line, and the amounts as text (they were under a title).
    await expect(page.getByRole('button', { name: 'Leave out 1 total line' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Convert 1 text column to numbers' })).toBeVisible()
    await idle(page)
    await page.keyboard.press('ControlOrMeta+z')
    await expect(page.locator('.result-meta')).toContainText('5 rows · 3 columns')
    // Any row near the top can be picked by its number, too.
    const box = (await page.locator('.grid-scroll').boundingBox())!
    await page.mouse.click(box.x + 12, box.y + 44 + 30 + 15) // row 2's number
    await page.locator('.statusbar').getByRole('button', { name: 'Use row 2 as column names' }).click()
    await expect(page.locator('.result-meta')).toContainText('3 rows · 3 columns')
  })
})
