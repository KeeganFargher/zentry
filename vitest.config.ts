import { resolve } from "node:path";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        // Tests never reach Cloudflare: CI has no credentials, and the AI
        // binding would otherwise spend neurons. Notify tests inject their own
        // summarizer.
        remoteBindings: false,
        miniflare: {
          // The probe Worker itself is exercised by the multi-Worker Playwright suite.
          serviceBindings: { UPTIME_PROBE: () => new Response(null, { status: 503 }) },
          bindings: { TEST_MIGRATIONS: migrations, EMAIL_SIGNING_KEY: "test-signing-key" },
        },
      }),
    ],
    resolve: { alias: { "@": resolve(import.meta.dirname, "src") } },
    test: { include: ["test/**/*.test.ts"], setupFiles: ["./test/setup.ts"] },
  };
});
