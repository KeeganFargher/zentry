import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { evaluateCronDeadlines } from "@/cron/cron-deadlines";
import { CronStore } from "@/db/cron-store";
import { receiveCheckIn } from "@/ingest/cron-receive";
import type { ApiMonitor, ApiMonitorRule, MonitorTimeline } from "@/shared/contract";
import { CheckIn } from "@/shared/monitors";
import { MINUTE } from "@/shared/time";

import { api } from "./api-helpers";
import { createProject, NOW } from "./helpers";

// The API answers at NOW (10:30); an hourly monitor next expects 11:00.
const HOUR = Math.floor(NOW / (60 * MINUTE)) * 60 * MINUTE;

type Fixture = { projectId: number; monitor: ApiMonitor; rule: ApiMonitorRule };

async function hourlyMonitorWithAlert(): Promise<Fixture> {
  const { id: projectId } = await createProject();
  const slug = `nightly-${crypto.randomUUID().slice(0, 8)}`;

  const rule = await (
    await api("/organizations/default/monitor-alert-rules/", {
      method: "POST",
      body: {
        name: "On-call",
        channels: ["email"],
        triggers: ["failure"],
        audience: { kind: "project" },
      },
    })
  ).json<ApiMonitorRule>();

  const created = await api("/organizations/default/monitors/", {
    method: "POST",
    body: {
      projectId,
      type: "cron",
      name: "Nightly export",
      alertRuleIds: [rule.id],
      notify: true,
      config: { slug, schedule: { type: "crontab", crontab: "0 * * * *" } },
    },
  });

  expect(created.status).toBe(201);

  return { projectId, monitor: await created.json<ApiMonitor>(), rule };
}

/** One ok check-in at NOW, then the 11:00 run missed. */
async function missTheNextRun({ projectId, monitor }: Fixture): Promise<void> {
  if (monitor.type !== "cron") {
    throw new Error("expected a cron monitor");
  }

  const store = new CronStore(env.DB);

  const checkIn = CheckIn.parse({
    check_in_id: crypto.randomUUID(),
    monitor_slug: monitor.config.slug,
    status: "ok",
  });

  await receiveCheckIn(store, { projectId, checkIn, now: NOW });
  await evaluateCronDeadlines(store, HOUR + 62 * MINUTE);
}

async function listed(id: string): Promise<ApiMonitor> {
  const monitors = await (await api("/organizations/default/monitors/")).json<ApiMonitor[]>();
  const found = monitors.find((monitor) => monitor.id === id);

  if (found === undefined) {
    throw new Error(`monitor ${id} is not listed`);
  }

  return found;
}

async function ruleOf(id: string): Promise<ApiMonitorRule> {
  const rules = await (
    await api("/organizations/default/monitor-alert-rules/")
  ).json<ApiMonitorRule[]>();

  const found = rules.find((rule) => rule.id === id);

  if (found === undefined) {
    throw new Error(`rule ${id} is not listed`);
  }

  return found;
}

type Range = { since: number; until: number; buckets: number };

function timelineUrl(id: string, { since, until, buckets }: Range): string {
  return `/organizations/default/monitors/${id}/timeline/?since=${since}&until=${until}&buckets=${buckets}`;
}

describe("the monitor timeline", () => {
  it("buckets check-ins by environment and status, the miss at its expected time", async () => {
    const fixture = await hourlyMonitorWithAlert();

    await missTheNextRun(fixture);

    const response = await api(
      timelineUrl(fixture.monitor.id, { since: HOUR, until: HOUR + 120 * MINUTE, buckets: 120 }),
    );

    const timeline = await response.json<MonitorTimeline>();

    expect(response.status).toBe(200);
    expect(timeline).toEqual({
      since: HOUR,
      until: HOUR + 120 * MINUTE,
      bucketMs: MINUTE,
      buckets: [
        { index: 30, scope: "production", status: "ok", count: 1, value: null },
        { index: 60, scope: "production", status: "missed", count: 1, value: null },
      ],
    });
  });

  it("rounds a bucket up to whole minutes", async () => {
    const { monitor } = await hourlyMonitorWithAlert();

    const timeline = await (
      await api(timelineUrl(monitor.id, { since: HOUR, until: HOUR + 90 * MINUTE, buckets: 60 }))
    ).json<MonitorTimeline>();

    expect(timeline.bucketMs).toBe(2 * MINUTE);
  });

  it("refuses an empty or over-long range and too few buckets", async () => {
    const { monitor } = await hourlyMonitorWithAlert();

    expect(
      (await api(timelineUrl(monitor.id, { since: HOUR, until: HOUR, buckets: 60 }))).status,
    ).toBe(400);
    expect(
      (
        await api(
          timelineUrl(monitor.id, {
            since: HOUR - 31 * 24 * 60 * MINUTE,
            until: HOUR,
            buckets: 60,
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (await api(timelineUrl(monitor.id, { since: HOUR, until: HOUR + 60 * MINUTE, buckets: 5 })))
        .status,
    ).toBe(400);
  });

  it("answers 404 for a monitor that does not exist", async () => {
    const response = await api(
      timelineUrl(crypto.randomUUID(), { since: HOUR, until: HOUR + 60 * MINUTE, buckets: 60 }),
    );

    expect(response.status).toBe(404);
  });
});

describe("the monitor list and alerts", () => {
  it("shows a monitor's last issue and when its alert last routed", async () => {
    const fixture = await hourlyMonitorWithAlert();

    expect((await listed(fixture.monitor.id)).lastIssue).toBeNull();
    expect((await ruleOf(fixture.rule.id)).lastTriggered).toBeNull();

    await missTheNextRun(fixture);

    const transition = await env.DB.prepare(
      "SELECT happened_at AS at FROM monitor_transitions WHERE monitor_id = ?1",
    )
      .bind(fixture.monitor.id)
      .first<{ at: number }>();

    expect(transition).not.toBeNull();
    const { lastIssue } = await listed(fixture.monitor.id);

    expect(lastIssue).toMatchObject({ title: "Nightly export", status: "unresolved" });
    expect(lastIssue?.shortId).toMatch(/^[A-Z0-9-]+-\d+$/);
    expect((await ruleOf(fixture.rule.id)).lastTriggered).toBe(transition?.at);
  });

  it("does not count a suppressed delivery as triggered", async () => {
    const fixture = await hourlyMonitorWithAlert();

    // A muted monitor still records the delivery, suppressed as "muted".
    await api(`/organizations/default/monitors/${fixture.monitor.id}/mute/`, {
      method: "PUT",
      body: { version: fixture.monitor.version, until: NOW + 24 * 60 * MINUTE },
    });
    await missTheNextRun(fixture);

    const suppressed = await env.DB.prepare(
      "SELECT suppression FROM monitor_deliveries WHERE rule_id = ?1",
    )
      .bind(fixture.rule.id)
      .all<{ suppression: string | null }>();

    expect(suppressed.results).toEqual([{ suppression: "muted" }]);
    expect((await ruleOf(fixture.rule.id)).lastTriggered).toBeNull();
  });
});
