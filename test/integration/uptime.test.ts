import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { handleUptimeBatch } from "@/cron/uptime";
import { MonitorPreviews } from "@/db/monitor-previews";
import { MonitorStore } from "@/db/monitors";
import { UptimeMonitorStore } from "@/db/uptime-monitors";
import { CreateMonitor } from "@/shared/monitors";
import type { ScheduledUptimeJob } from "@/shared/monitors";
import { MINUTE } from "@/shared/time";

import { createOrganization, createProject } from "./helpers";
import { addMember } from "./notify-helpers";

describe("scheduled uptime queue", () => {
  it("records a failed probe service as unknown and does not probe again on redelivery", async () => {
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
    await handleUptimeBatch(batch, deps);
    await handleUptimeBatch(batch, deps);
    expect(requests).toBe(1);

    const history = await monitors.timeline.history(1, monitor.id, {
      time: Number.MAX_SAFE_INTEGER,
      id: Number.MAX_SAFE_INTEGER,
      size: 1,
    });

    // Zentry's own failure is not downtime: the slot is unknown, not failed.
    expect(history).toMatchObject([
      { health: "unknown", evidence: { outcome: "unknown", reason: "probe_unavailable" } },
    ]);
  });

  it("records a probe that started but never finished as a coverage gap", async () => {
    const { id: projectId } = await createProject();
    const owner = await addMember(1);
    const now = Date.now();
    const slot = Math.floor(now / MINUTE) * MINUTE;
    const store = new UptimeMonitorStore(env.DB);

    const monitor = await new MonitorStore(env.DB).create(
      1,
      CreateMonitor.parse({
        projectId,
        name: "Lost result",
        type: "uptime",
        config: { url: "https://status.example.com/lost", intervalMinutes: 1 },
      }),
      { userId: owner.id, time: slot, requestKey: null },
    );

    if (monitor === null) {
      throw new Error("monitor was not created");
    }

    const job = { id: monitor.id, token: crypto.randomUUID() };
    expect(await store.claim({ slot, token: job.token, now })).toContainEqual({ id: job.id });

    // The Worker stops after starting the probe and before saving its result.
    expect(await store.start(job, now)).not.toBeNull();
    await store.claim({ slot: slot + MINUTE, token: crypto.randomUUID(), now: now + MINUTE + 1 });

    const history = await new MonitorStore(env.DB).timeline.history(1, monitor.id, {
      time: Number.MAX_SAFE_INTEGER,
      id: Number.MAX_SAFE_INTEGER,
      size: 1,
    });

    expect(history).toMatchObject([{ health: "unknown", evidence: { reason: "coverage_gap" } }]);
  });

  it("leases at most 25 probes per organization per tick and rotates through the rest", async () => {
    const organizationId = await createOrganization(1_000_000);
    const { id: projectId } = await createProject(null, organizationId);
    const owner = await addMember(organizationId);
    const now = Date.now();
    const slot = Math.floor(now / MINUTE) * MINUTE;
    const monitors = new MonitorStore(env.DB);
    const store = new UptimeMonitorStore(env.DB);

    for (let index = 0; index < 30; index += 1) {
      await monitors.create(
        organizationId,
        CreateMonitor.parse({
          projectId,
          name: `Probe ${index}`,
          type: "uptime",
          config: { url: `https://status.example.com/${index}`, intervalMinutes: 1 },
        }),
        { userId: owner.id, time: slot, requestKey: null },
      );
    }

    const mine = async (claimed: { id: string }[]): Promise<string[]> => {
      const own = new Set(
        (await monitors.list(organizationId, { kind: "all" })).map(({ id }) => id),
      );

      return claimed.flatMap(({ id }) => (own.has(id) ? [id] : []));
    };

    const first = await mine(await store.claim({ slot, token: crypto.randomUUID(), now }));
    expect(first).toHaveLength(25);

    // A minute later the leases have expired; the five never claimed go first.
    const second = await mine(
      await store.claim({ slot: slot + MINUTE, token: crypto.randomUUID(), now: now + MINUTE + 1 }),
    );

    expect(second.filter((id) => !first.includes(id))).toHaveLength(5);
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
