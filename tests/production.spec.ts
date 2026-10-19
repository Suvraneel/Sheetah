import { spawn, type ChildProcess } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from './fixtures'
import { openApp } from './helpers'

const ROOT = join(import.meta.dirname, '..')

test.describe('production shell', () => {
  test('search engines and link previews get a real description', async ({ page, request }) => {
    await page.goto('/')
    const head = page.locator('head')
    await expect(head.locator('link[rel=canonical]')).toHaveAttribute('href', /^https:\/\/.+\/$/)
    await expect(head.locator('meta[property="og:image"]')).toHaveAttribute('content', /^https:\/\/.+\/og\.png$/)
    await expect(head.locator('meta[name="twitter:card"]')).toHaveAttribute('content', 'summary_large_image')
    const ld = JSON.parse((await head.locator('script[type="application/ld+json"]').textContent()) ?? '{}')
    expect(ld['@type']).toBe('SoftwareApplication')

    // The static HTML (before any script runs) already describes the product.
    const html = await (await request.get('/')).text()
    expect(html).toContain('Sheetah: open the whole file')
    for (const path of ['/robots.txt', '/sitemap.xml', '/privacy.html', '/og.png', '/icons/icon-512.png', '/apple-touch-icon.png']) {
      expect((await request.get(path)).status(), path).toBe(200)
    }
    const manifest = await (await request.get('/manifest.webmanifest')).json()
    expect(manifest.icons.some((i: { purpose: string }) => i.purpose === 'maskable')).toBe(true)
  })

  test('a browser without WebAssembly gets an explanation, not a blank page', async ({ page }) => {
    await page.addInitScript(() => {
      // @ts-expect-error simulating an old browser
      delete window.WebAssembly
    })
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Sheetah needs a newer browser' })).toBeVisible()
    await expect(page.locator('body')).toContainText('Nothing was uploaded')
  })

  test('the sample-data shortcut (?demo=1) opens the sample', async ({ page }) => {
    await page.goto('/?demo=1')
    await expect(page.locator('.result-meta')).toContainText('1,000,000 rows', { timeout: 90_000 })
    expect(page.url()).not.toContain('demo')
  })

})

/*
 * Updates are tested against a copy of the build on its own server: simulating a deploy rewrites the
 * service worker, which must not reach tests running in parallel against the main server.
 */
test.describe('updates', () => {
  const PORT = 4181
  let DIST = ''
  let server: ChildProcess | null = null
  test.use({ baseURL: `http://localhost:${PORT}` })

  test.beforeAll(async () => {
    DIST = mkdtempSync(join(tmpdir(), 'sheetah-dist-'))
    cpSync(join(ROOT, 'dist'), DIST, { recursive: true })
    server = spawn(join(ROOT, 'node_modules', '.bin', 'vite'), ['preview', '--outDir', DIST, '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: 'ignore' })
    for (let i = 0; i < 100; i++) {
      if (await fetch(`http://localhost:${PORT}/`).then((r) => r.ok, () => false)) return
      await new Promise((r) => setTimeout(r, 200))
    }
    throw new Error('The update test server did not start')
  })
  test.afterAll(() => {
    server?.kill()
    if (DIST) rmSync(DIST, { recursive: true, force: true })
  })

  /** Simulates a deploy: new worker bytes (its build version), optionally a manifest without this tab's files. */
  function deploy(changeBuild: boolean) {
    const sw = join(DIST, 'sw.js')
    const manifest = join(DIST, 'precache-manifest.json')
    const original = { sw: readFileSync(sw, 'utf8'), manifest: readFileSync(manifest, 'utf8') }
    const version = /const VERSION = '([^']+)'/.exec(original.sw)![1]
    writeFileSync(sw, original.sw.replace(`const VERSION = '${version}'`, `const VERSION = '${version}-next'`))
    if (changeBuild) {
      // The next build's entry script has another name: drop this build's entry from the list.
      const m = JSON.parse(original.manifest) as { files: string[] }
      m.files = m.files.filter((f) => !/^assets\/index-[^/]+\.js$/.test(f))
      writeFileSync(manifest, JSON.stringify(m))
    }
    return {
      version,
      restore: () => {
        writeFileSync(sw, original.sw)
        writeFileSync(manifest, original.manifest)
      },
    }
  }
  const versionCaches = (page: Page) => page.evaluate(() => caches.keys()).then((k) => k.filter((x) => x.startsWith('sheetah-')).sort(), () => [] as string[])
  const checkForUpdate = (page: Page) => page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.update())

  test('a new deploy is offered, not forced; the previous offline copy is kept for other tabs', async ({ page }) => {
    await openApp(page)
    await expect(page.locator('.engine-pill')).toContainText('works offline', { timeout: 90_000 })
    expect(await versionCaches(page)).toHaveLength(1)

    const d = deploy(true)
    try {
      await checkForUpdate(page)
      await expect(page.locator('.toast', { hasText: 'A new version of Sheetah is ready.' })).toBeVisible({ timeout: 60_000 })
      await Promise.all([page.waitForEvent('framenavigated'), page.getByRole('button', { name: 'Reload' }).click()])
      await page.waitForLoadState('load')
      await expect.poll(() => versionCaches(page), { timeout: 30_000 }).toEqual([`sheetah-${d.version}`, `sheetah-${d.version}-next`].sort())
    } finally {
      d.restore()
    }
  })

  test('a deploy of the build this tab already runs is swapped in without asking', async ({ page }) => {
    await openApp(page)
    await expect(page.locator('.engine-pill')).toContainText('works offline', { timeout: 90_000 })
    const d = deploy(false)
    try {
      await checkForUpdate(page)
      await expect.poll(() => versionCaches(page), { timeout: 60_000 }).toContain(`sheetah-${d.version}-next`)
      await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? ''), { timeout: 30_000 }).toContain('sw.js')
      await page.waitForTimeout(500)
      await expect(page.locator('.toast', { hasText: 'A new version of Sheetah is ready.' })).toHaveCount(0)
    } finally {
      d.restore()
    }
  })

  test('updating in one tab tells the other tab, which keeps working until it reloads', async ({ context }) => {
    const one = await context.newPage()
    await openApp(one)
    await expect(one.locator('.engine-pill')).toContainText('works offline', { timeout: 90_000 })
    const two = await context.newPage()
    await openApp(two)
    const d = deploy(true)
    try {
      await checkForUpdate(one)
      await expect(one.locator('.toast', { hasText: 'A new version of Sheetah is ready.' })).toBeVisible({ timeout: 60_000 })
      await expect(two.locator('.toast', { hasText: 'A new version of Sheetah is ready.' })).toBeVisible({ timeout: 60_000 })
      await Promise.all([one.waitForEvent('framenavigated'), one.getByRole('button', { name: 'Reload' }).click()])
      // The other tab is now served by the new worker but still runs its build: lazily loaded parts
      // (the SQL editor) still load, and its data stays until the user chooses to reload.
      await two.locator('input[type=file]').setInputFiles({ name: 'later.csv', mimeType: 'text/csv', buffer: Buffer.from('a,b\n1,2\n') })
      await expect(two.locator('.cm-content')).toContainText('later')
      await Promise.all([two.waitForEvent('framenavigated'), two.getByRole('button', { name: 'Reload' }).click()])
    } finally {
      d.restore()
    }
  })
})
