import { expect, test } from './fixtures'
import { openApp } from './helpers'

const file = (name: string, text: string) => ({ name, mimeType: 'text/csv', buffer: Buffer.from(text) })

const OCT = 'id,name,city,balance\n1,Asha,Pune,100.00\n2,Ben,Delhi,250.50\n3,Chen,Oslo,75.00\n4,Dana,Lima,10.00\n'
// id 1: only case/space and a sub-cent difference (a change unless those are ignored) · 2: city · 3: balance · 4 removed · 5 added
const NOV = 'id,name,city,balance,tier\n1,Asha,pune ,100.004,gold\n2,Ben,Mumbai,250.50,silver\n3,Chen,Oslo,80.00,gold\n5,Eve,Rome,5.00,bronze\n'

test.describe('compare two tables', () => {
  test('finds added, removed and changed rows by key, with readable SQL and filters', async ({ page }) => {
    await openApp(page)
    await page.locator('input[type=file]').setInputFiles([file('customers_oct.csv', OCT), file('customers_nov.csv', NOV)])
    await expect(page.locator('.side-table')).toHaveCount(2)

    // Two versions of the same export: Sheetah offers to compare them.
    await page.getByRole('button', { name: 'Compare them' }).click()
    const dialog = page.getByRole('dialog', { name: 'What changed between two tables?' })
    await expect(dialog.getByLabel('Before')).toHaveValue('customers_oct')
    await expect(dialog.getByLabel('After')).toHaveValue('customers_nov')
    await expect(dialog.locator('.compare-schema')).toContainText('Only in customers_nov: tier')
    await expect(dialog.locator('.pivot-name')).toHaveText(['id']) // suggested key
    await expect(dialog).toContainText('unique and never empty in both tables')
    await dialog.getByRole('button', { name: 'Compare', exact: true }).click()

    await expect(page.locator('.result-meta')).toContainText('5 rows')
    await expect(page.locator('.cm-content')).toContainText('-- Compare: customers_oct (before) → customers_nov (after), matched by id')
    await expect(page.locator('.change-chip')).toHaveText(['1 removed', '1 added', '3 changed'])
    await expect(page.locator('.error-banner')).toHaveCount(0)

    // The chips filter the result.
    await page.locator('.change-chip', { hasText: 'changed' }).click()
    await expect(page.locator('.result-meta')).toContainText('3 of 5 rows')
    await expect(page.locator('.sr-grid [role=row]').nth(1)).toContainText('city')
    await expect(page.locator('.sr-grid [role=row]').nth(1)).toContainText('city: Pune → pune') // what changed, readable in place
    await page.locator('.change-chip', { hasText: 'changed' }).click()
    await expect(page.locator('.result-meta')).toContainText('5 rows')

    // Looser options ignore the case-only and sub-cent differences.
    await page.getByRole('button', { name: 'Edit compare' }).click()
    await dialog.getByLabel('Ignore upper / lower case').check()
    await dialog.getByLabel(/Ignore differences under 0\.01/).check()
    await dialog.getByRole('button', { name: 'Compare', exact: true }).click()
    await expect(page.locator('.change-chip')).toHaveText(['1 removed', '1 added', '2 changed'])
  })

  test('without a key, whole rows are compared', async ({ page }) => {
    await openApp(page)
    await page.locator('input[type=file]').setInputFiles([file('a.csv', 'x,y\n1,a\n1,a\n2,b\n'), file('b.csv', 'x,y\n1,a\n3,c\n')])
    await page.getByRole('button', { name: 'Compare two tables' }).click()
    const dialog = page.getByRole('dialog', { name: 'What changed between two tables?' })
    await dialog.getByLabel('Before').selectOption('a')
    await dialog.getByLabel('After').selectOption('b')
    await dialog.getByLabel('Whole rows (no key)').check()
    await dialog.getByRole('button', { name: 'Compare', exact: true }).click()
    // a has (1,a) twice and (2,b); b has (1,a) and (3,c): removed (1,a) once and (2,b), added (3,c).
    await expect(page.locator('.result-meta')).toContainText('3 rows')
    await expect(page.locator('.cm-content')).toContainText('EXCEPT ALL')
  })
})
