// End-to-end tests: a real browser runs the fixture shop, whose Sentry SDK
// reports to a local Zentry started from a clean database.

import { randomUUID } from "node:crypto";

import { defineConfig } from "@playwright/test";

import { SHOP_URL, ZENTRY_URL } from "./urls";

const STATE = `.wrangler/e2e-${randomUUID()}`;

const startZentry = [
  `wrangler d1 migrations apply zentry --local --persist-to ${STATE}`,
  `wrangler dev -c wrangler.jsonc -c e2e/wrangler.probe.jsonc --var UPTIME_ORIGINS:http://localhost:5199 --port 8798 --host localhost:8798 --inspector-port 9339 --persist-to ${STATE} --var DEV_USER_EMAIL:e2e@localhost`,
].join(" && ");

export default defineConfig({
  testDir: ".",
  testMatch: "*.spec.ts",
  outputDir: "../.wrangler/e2e-results",
  fullyParallel: true,
  forbidOnly: process.env["CI"] !== undefined,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  use: {
    // The installed Chrome, so no browser download is needed.
    channel: process.env["E2E_BROWSER_CHANNEL"] ?? "chrome",
    baseURL: ZENTRY_URL,
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: startZentry,
      cwd: "..",
      url: `${ZENTRY_URL}/api/0/me/`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: "vite e2e/shop -c e2e/shop/vite.config.ts --port 5199 --strictPort",
      cwd: "..",
      url: SHOP_URL,
      reuseExistingServer: false,
    },
  ],
});
