import { defineConfig, devices } from '@playwright/test'

// End-to-end tests run against the production build served by `vite preview`, which sends the same
// security headers as vercel.json, so every test runs under the real Content-Security-Policy.
// Build first (`npm test` does), or run `npx playwright test` after `npm run build`.
const PORT = 4173

export default defineConfig({
  testDir: './tests',
  globalSetup: './tests/global-setup.ts',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 2, // the engine is CPU-heavy; more workers just make timings flaky
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    // Lets a pre-installed Chromium be used when Playwright's own download isn't available.
    launchOptions: process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: `npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
