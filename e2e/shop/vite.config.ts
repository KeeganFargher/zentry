import { existsSync } from "node:fs";

import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    {
      name: "uptime-fixture",
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.url === "/monitor-redirect") {
            response.writeHead(302, { Location: "/" }).end();

            return;
          }

          if (request.url === "/monitor-timeout") {
            const timer = setTimeout(() => response.end(), 3000);
            response.on("close", () => clearTimeout(timer));

            return;
          }

          const match = /^\/monitor-health\/([a-f0-9-]{36})$/.exec(request.url ?? "");
          const id = match?.[1];

          if (id === undefined) {
            next();

            return;
          }

          response.statusCode = existsSync(new URL(`../../.wrangler/uptime-${id}`, import.meta.url))
            ? 204
            : 503;
          response.end();
        });
      },
    },
  ],
});
