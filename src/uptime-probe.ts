import { z } from "zod";

import { jsonText } from "@/shared/json";
import { approvedUptimeTarget, productionUptimeTarget } from "@/shared/uptime";

type ProbeEnv = { UPTIME_ORIGINS: string; FIXTURE_ORIGIN: string };

const Input = jsonText(
  z.strictObject({
    url: z.url().max(512),
    method: z.enum(["GET", "HEAD"]),
    timeoutMs: z.int().min(1000).max(15000),
  }),
);

export default {
  async fetch(request, env): Promise<Response> {
    const parsed = Input.safeParse(await request.text());

    if (!parsed.success) {
      return Response.json({ outcome: "unknown" });
    }

    const { url, method, timeoutMs } = parsed.data;
    const target = new URL(url);

    const approved =
      approvedUptimeTarget(target, env.UPTIME_ORIGINS) && productionUptimeTarget(target);

    const fixture =
      env.FIXTURE_ORIGIN === "http://localhost:5199" &&
      approvedUptimeTarget(target, env.FIXTURE_ORIGIN);

    if (!approved && !fixture) {
      return Response.json({ outcome: "unknown" });
    }

    const start = Date.now();

    try {
      const response = await fetch(target, {
        method,
        redirect: "manual",
        cache: "no-store",
        headers: { "User-Agent": "ZentryUptime/1" },
        signal: AbortSignal.timeout(timeoutMs),
      });

      await response.body?.cancel();

      return Response.json({
        outcome: response.ok ? "ok" : "failed",
        httpStatus: response.status,
        durationMs: Date.now() - start,
      });
    } catch {
      return Response.json({ outcome: "failed", durationMs: Date.now() - start });
    }
  },
} satisfies ExportedHandler<ProbeEnv>;
