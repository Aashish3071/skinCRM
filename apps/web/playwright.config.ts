import { defineConfig, devices } from "@playwright/test";

/**
 * Browser tests for the most valuable front-desk workflow.
 *
 * Needs the API and web running against a seeded database:
 *   pnpm dev                      # API on 4000, web on 3000
 *   pnpm --filter @skincrm/web e2e
 * Point elsewhere with E2E_BASE_URL (web) and E2E_API_URL (API).
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  // Browser scenarios share one seeded clinic and change its settings.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], ...(process.env.E2E_BROWSER_CHANNEL ? { channel: process.env.E2E_BROWSER_CHANNEL } : {}) } }],
});
