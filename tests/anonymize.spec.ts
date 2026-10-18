import { expect, test } from './fixtures'
import { exportAs, openApp } from './helpers'

const file = (name: string, text: string) => ({ name, mimeType: 'text/csv', buffer: Buffer.from(text) })

// Valid checksums: Aadhaar (Verhoeff) and card numbers (Luhn) below are test values, not real ones.
const CUSTOMERS = [
  'id,full_name,email,mobile,aadhaar,pan,card_number,last_ip,dob,city,notes',
  '1,Asha Rao,asha.rao@example.com,+91 98765 43210,2345 6789 0124,ABCPE1234F,4111 1111 1111 1111,203.0.113.42,1990-05-14,Pune,called twice',
  '2,Ben Thomas,ben@example.org,9123456780,3456 7890 1236,BCDPT2345G,5500 0000 0000 0004,198.51.100.7,1985-11-02,Delhi,',
  '3,Chen Li,chen.li@example.net,08765432109,4567 8901 2346,CDEPL3456H,3400 0000 0000 009,192.0.2.200,2001-01-30,Oslo,vip',
  '4,Dana Iyer,dana@example.com,+91-7012345678,5678 9012 3458,DEFPI4567J,6011 0000 0000 0004,203.0.113.9,1979-07-21,Lima,',
].join('\n')

test.describe('anonymize', () => {
  test('finds personal data, masks it with sensible defaults, and exports a clean file', async ({ page }) => {
    await openApp(page)
    await page.locator('input[type=file]').setInputFiles([file('customers.csv', CUSTOMERS)])
    await expect(page.locator('.result-meta')).toContainText('4 rows')
    // Spotted quietly after opening.
    await expect(page.locator('.pii-chip')).toContainText('Personal data in')
    await page.locator('.pii-chip').click()

    const dialog = page.getByRole('dialog', { name: 'Remove personal data before you share' })
    const flagged = dialog.getByRole('list', { name: 'Columns with personal data' })
    for (const col of ['full_name', 'email', 'mobile', 'aadhaar', 'pan', 'card_number', 'last_ip', 'dob']) {
      await expect(flagged.locator('.anon-name', { hasText: new RegExp(`^${col}$`) }), col).toHaveCount(1)
    }
    await expect(flagged.locator('.anon-row', { hasText: 'aadhaar' })).toContainText('valid checksums')
    await expect(flagged.locator('.anon-name', { hasText: /^city$/ })).toHaveCount(0)
    // Previews show the effect on real values before anything runs.
    await expect(flagged.locator('.anon-row', { hasText: 'mobile' }).locator('.anon-preview b').first()).toHaveText(/^••••••\d{4}$/)

    await dialog.getByLabel('What to do with notes').waitFor({ state: 'detached' }).catch(() => {})
    await dialog.getByRole('button', { name: /Show the other/ }).click()
    await dialog.getByLabel('What to do with notes').selectOption('remove')
    await dialog.getByRole('button', { name: 'Create anonymized result' }).click()

    await expect(page.locator('.cm-content')).toContainText('-- Anonymized copy of customers')
    await expect(page.locator('.cm-content')).toContainText('EXCLUDE (notes, __row)')
    await expect(page.locator('.result-meta')).toContainText('4 rows · 10 columns')
    await expect(page.locator('.toast', { hasText: 'Anonymized result' })).toBeVisible()

    const dl = await exportAs(page, 'CSV')
    expect(dl.suggestedFilename()).toMatch(/^customers-anonymized-\d{4}-\d{2}-\d{2}\.csv$/)
    const csv = (await (await dl.createReadStream()).toArray()).join('')
    for (const secret of ['Asha Rao', 'asha.rao@example.com', '98765 43210', '2345 6789 0124', 'ABCPE1234F', '4111 1111 1111 1111', '203.0.113.42', '1990-05-14', 'called twice']) {
      expect(csv, secret).not.toContain(secret)
    }
    expect(csv).toContain('XXXX XXXX 0124') // last 4 kept for reference
    expect(csv).toContain('203.0.113.0/24')
    expect(csv).toContain('Person ')
    expect(csv).not.toContain('@') // emails became pseudonyms
    expect(csv).not.toContain('1990-05') // birth dates keep the year only
    expect(csv.split('\n')[1]).toMatch(/^1,Person \d+,[0-9a-f]{12},••••••3210,XXXX XXXX 0124,XXXXXX234F,XXXX XXXX XXXX 1111,203\.0\.113\.0\/24,1990,Pune$/) // row order kept
  })

  test('pseudonyms are consistent within a session, so counts and joins still work', async ({ page }) => {
    await openApp(page)
    await page.locator('input[type=file]').setInputFiles([file('visits.csv', 'email,page\na@x.com,home\nb@x.com,home\na@x.com,cart\n')])
    await page.getByRole('button', { name: 'Anonymize' }).click()
    const dialog = page.getByRole('dialog', { name: 'Remove personal data before you share' })
    await expect(dialog.getByLabel('What to do with email')).toHaveValue('pseudonym')
    await dialog.getByRole('button', { name: 'Create anonymized result' }).click()
    await expect(page.locator('.result-meta')).toContainText('3 rows')
    // Same email → same code; and the key isn't in the SQL.
    const sql = await page.locator('.cm-content').innerText()
    expect(sql).toContain('pseudonym(email)')
    expect(sql).not.toMatch(/[0-9a-f]{64}/)
    await page.locator('.cm-content').click()
    await page.keyboard.press('ControlOrMeta+End')
    await page.keyboard.insertText('\n')
    await page.keyboard.press('ControlOrMeta+a')
    await page.keyboard.insertText(`SELECT count(DISTINCT email) AS people FROM (${sql.replace(/^--.*\n/, '')})`)
    await page.keyboard.press('ControlOrMeta+Enter')
    await expect(page.locator('.result-meta')).toContainText('1 row')
    await expect(page.locator('.sr-grid [role=row]').nth(1)).toContainText('2')
  })
})
