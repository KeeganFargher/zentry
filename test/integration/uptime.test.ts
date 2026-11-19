import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { handleUptimeBatch } from "@/cron/uptime";
import { MonitorPreviews } from "@/db/monitor-previews";
import { MonitorStore } from "@/db/monitors";
import { UptimeMonitorStore } from "@/db/uptime-monitors";
import { CreateMonitor } from "@/shared/monitors";
import type { ScheduledUptimeJob } from "@/shared/monitors";
import { MINUTE } from "@/shared/time";

import { createProject } from "./helpers";
import { addMember } from "./notify-helpers";

describe("scheduled uptime queue", () => {
  it("does not repeat an ambiguous fetch on redelivery and records the expired lease as a gap", async () => {
    const { id: projectId } = await createProject();
    const owner = await addMember(1);
    const now = Date.now();
    const slot = Math.floor(now / MINUTE) * MINUTE;
    const monitors = new MonitorStore(env.DB);
    const store = new UptimeMonitorStore(env.DB);

    const monitor = await monitors.create(
      1,
      CreateMonitor.parse({
        projectId,
        name: "Ambiguous probe",
        type: "uptime",
        config: { url: "https://status.example.com/health", intervalMinutes: 1 },
      }),
      { userId: owner.id, time: slot, requestKey: null },
    );

    if (monitor === null) {
      throw new Error("monitor was not created");
    }

    const job = { id: monitor.id, token: crypto.randomUUID() };
    expect(await store.claim({ slot, token: job.token, now })).toContainEqual({ id: job.id });
    let requests = 0;

    const binding = {
      fetch: async (): Promise<Response> => {
        requests += 1;
        throw new Error("Probe Worker response lost");
      },
    };

    const batch = delivery(job);
    const deps = { store, previews: new MonitorPreviews(env.DB), binding };
    await expect(handleUptimeBatch(batch, deps)).rejects.toThrow("Probe Worker response lost");
    await handleUptimeBatch(batch, deps);
    expect(requests).toBe(1);

    await store.finish(job, { outcome: "ok" }, now + MINUTE + 1);
    await store.claim({ slot: slot + MINUTE, token: crypto.randomUUID(), now: now + MINUTE + 1 });

    const history = await monitors.timeline.history(1, monitor.id, {
      time: Number.MAX_SAFE_INTEGER,
      id: Number.MAX_SAFE_INTEGER,
      size: 1,
    });

    expect(history).toMatchObject([{ health: "unknown", evidence: { reason: "coverage_gap" } }]);
  });
});

function delivery(job: ScheduledUptimeJob): MessageBatch<ScheduledUptimeJob> {
  return {
    queue: "zentry-uptime",
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    messages: [
      { id: job.id, body: job, timestamp: new Date(), attempts: 1, ack: () => {}, retry: () => {} },
    ],
    ackAll: () => {},
    retryAll: () => {},
  };
}
