import { expect, test as base } from '@playwright/test'

/*
 * Every end-to-end test also checks that the page threw nothing it didn't handle: an uncaught error
 * (or an unhandled promise rejection) in any page the test opened fails the test, even when what it
 * asserted on screen looked right. A test that provokes one on purpose lists it in `allowPageErrors`.
 */
export const test = base.extend<{ allowPageErrors: RegExp[]; pageErrors: void }>({
  allowPageErrors: [[], { option: true }],
  pageErrors: [
    async ({ context, allowPageErrors }, use) => {
      const errors: string[] = []
      const watch = (page: import('@playwright/test').Page) => {
        page.on('pageerror', (e) => errors.push(`${e.name}: ${e.message}`))
        // Errors React caught (the crash screen, a part that failed) are logged, not thrown: count them too.
        page.on('console', (m) => {
          if (/^Sheetah( crashed|: a part failed)/.test(m.text())) errors.push(m.text())
        })
      }
      context.pages().forEach(watch)
      context.on('page', watch)
      await use()
      for (const page of context.pages()) {
        if (!page.isClosed() && (await page.locator('.crash').count().catch(() => 0))) errors.push(`crash screen on ${page.url()}`)
      }
      expect(errors.filter((e) => !allowPageErrors.some((re) => re.test(e))), 'uncaught errors in the page').toEqual([])
    },
    { auto: true },
  ],
})

export { expect }
export type { Page } from '@playwright/test'
