import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `pnpm dev:ui` serves the UI with hot reload and proxies the API to `wrangler dev`.
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "~": resolve(import.meta.dirname, "src") } },
  build: { outDir: "dist", emptyOutDir: true },
  server: { proxy: { "/api": "http://localhost:8787" } },
});
