import { z } from "zod";

import { jsonText } from "@/shared/json";
import { approvedUptimeTarget, productionUptimeTarget } from "@/shared/uptime";

type ProbeEnv = {
  UPTIME_ORIGINS: string;
  FIXTURE_ORIGIN: string;
  DESTINATION_RL: RateLimit;
  UPTIME_PROBES_PAUSED: string;
  UPTIME_BLOCKED_HOSTS: string;
};

const ProbeInput = z.strictObject({
  organizationId: z.int().positive(),
  url: z.url().max(512),
  method: z.enum(["GET", "HEAD"]),
  timeoutMs: z.int().min(1000).max(15000),
  successCodes: z.array(z.int().min(100).max(599)).min(1).max(20).optional(),
});

const Input = jsonText(ProbeInput);

export default {
  async fetch(request, env): Promise<Response> {
    const input = Input.safeParse(await request.text());

    if (!input.success) {
      return Response.json({ outcome: "unknown", reason: "policy" });
    }

    const { url, organizationId } = input.data;
    const target = new URL(url);

    const fixture =
      env.FIXTURE_ORIGIN === "http://localhost:5199" && target.origin === env.FIXTURE_ORIGIN;

    if (env.UPTIME_PROBES_PAUSED !== "0") {
      return Response.json({ outcome: "unknown", reason: "paused" });
    }

    if (
      env.UPTIME_BLOCKED_HOSTS.split(",").includes(target.hostname) ||
      !approvedUptimeTarget(target, organizationId, env.UPTIME_ORIGINS) ||
      (!fixture && !productionUptimeTarget(target))
    ) {
      return Response.json({ outcome: "unknown", reason: "policy" });
    }

    if (!(await env.DESTINATION_RL.limit({ key: target.origin })).success) {
      return Response.json({ outcome: "unknown", reason: "budget" });
    }

    return executeProbe(target, input.data);
  },
} satisfies ExportedHandler<ProbeEnv>;

async function executeProbe(
  target: URL,
  { method, timeoutMs, successCodes }: z.infer<typeof ProbeInput>,
): Promise<Response> {
  const start = Date.now();
  const signal = AbortSignal.timeout(timeoutMs);

  try {
    const response = await fetch(target, {
      method,
      redirect: "manual",
      cache: "no-store",
      headers: { "User-Agent": "ZentryUptime/1" },
      signal,
    });

    await response.body?.cancel();

    const ok = successCodes === undefined ? response.ok : successCodes.includes(response.status);

    return Response.json({
      outcome: ok ? "ok" : "failed",
      reason: ok ? undefined : "status",
      httpStatus: response.status,
      durationMs: Date.now() - start,
    });
  } catch {
    return Response.json({
      outcome: "failed",
      reason: signal.aborted ? "timeout" : "network",
      durationMs: Date.now() - start,
    });
  }
}
