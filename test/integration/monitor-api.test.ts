import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { evaluateCronDeadlines } from "@/cron/cron-deadlines";
import { CronStore } from "@/db/cron-store";
import { MonitorRoutingStore } from "@/db/monitor-routing";
import { MonitorStore } from "@/db/monitors";
import { receiveCheckIn } from "@/ingest/cron-receive";
import { drainOutbox } from "@/notify/handler";
import { routeTransitions } from "@/notify/monitor-routing";
import type { ApiMonitor, ApiMonitorRule, Json, MonitorTimeline } from "@/shared/contract";
import { CheckIn, CreateMonitor } from "@/shared/monitors";
import { MINUTE } from "@/shared/time";

import { api } from "./api-helpers";
import { createProject, NOW } from "./helpers";
import { addMember, notifyHarness } from "./notify-helpers";

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

/**
 * Lets the notify worker route the outbox: deliveries are written when a
 * transition is routed, not when it happens.
 */
async function routeAlerts(): Promise<void> {
  await drainOutbox(notifyHarness().deps);
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

    expect(fixture.monitor.creator).toMatchObject({ kind: "member" });
    expect((await listed(fixture.monitor.id)).lastIssue).toBeNull();
    expect((await ruleOf(fixture.rule.id)).lastTriggered).toBeNull();

    await missTheNextRun(fixture);
    await routeAlerts();

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
    await routeAlerts();

    const suppressed = await env.DB.prepare(
      "SELECT suppression FROM monitor_deliveries WHERE rule_id = ?1",
    )
      .bind(fixture.rule.id)
      .all<{ suppression: string | null }>();

    expect(suppressed.results).toEqual([{ suppression: "muted" }]);
    expect((await ruleOf(fixture.rule.id)).lastTriggered).toBeNull();
  });
});

type Observation = { at: number; health: string; evidence: Json; severity: string | null };

async function signalMonitor(input: Json): Promise<ApiMonitor> {
  const { id: projectId } = await createProject();
  const { id: userId } = await addMember(1);

  const monitor = await new MonitorStore(env.DB).create(
    1,
    CreateMonitor.parse({ projectId, name: "Signal", ...Object(input) }),
    { userId, time: HOUR, requestKey: null },
  );

  if (monitor === null) {
    throw new Error("monitor was not created");
  }

  return monitor;
}

/** Observations as the uptime and metric evaluators record them. */
async function observe(monitor: ApiMonitor, observations: Observation[]): Promise<void> {
  await env.DB.batch(
    observations.map(({ at, health, evidence, severity }) =>
      env.DB.prepare(
        `INSERT INTO monitor_observations (monitor_id, evaluated_at, health, evidence, severity, generation)
         VALUES (?1, ?2, ?3, ?4, ?5, (SELECT generation FROM monitors WHERE id = ?1))`,
      ).bind(monitor.id, at, health, JSON.stringify(evidence), severity),
    ),
  );
}

describe("the timeline for uptime and metric monitors", () => {
  it("reads an uptime failure while failing as downtime, before it as a failure, and a skip as unknown", async () => {
    const monitor = await signalMonitor({
      type: "uptime",
      config: { url: "https://status.zentry.test/", intervalMinutes: 1 },
    });

    await observe(monitor, [
      { at: HOUR, health: "healthy", evidence: { outcome: "ok" }, severity: null },
      { at: HOUR + MINUTE, health: "degraded", evidence: { outcome: "failed" }, severity: null },
      { at: HOUR + 2 * MINUTE, health: "failing", evidence: { outcome: "failed" }, severity: null },
      {
        at: HOUR + 3 * MINUTE,
        health: "failing",
        evidence: { outcome: "unknown" },
        severity: null,
      },
    ]);

    const timeline = await (
      await api(timelineUrl(monitor.id, { since: HOUR, until: HOUR + 10 * MINUTE, buckets: 10 }))
    ).json<MonitorTimeline>();

    expect(timeline.buckets.map(({ index, status }) => [index, status])).toEqual([
      [0, "success"],
      [1, "failure"],
      [2, "downtime"],
      [3, "unknown"],
    ]);
  });

  it("reads a metric window's severity and its error count", async () => {
    const monitor = await signalMonitor({
      type: "metric",
      config: { windowSeconds: 300, threshold: 10, warningThreshold: 5 },
    });

    await observe(monitor, [
      { at: HOUR, health: "awaiting_data", evidence: {}, severity: null },
      { at: HOUR + MINUTE, health: "healthy", evidence: { count: 2 }, severity: null },
      { at: HOUR + 2 * MINUTE, health: "failing", evidence: { count: 7 }, severity: "medium" },
      { at: HOUR + 3 * MINUTE, health: "failing", evidence: { count: 12 }, severity: "high" },
    ]);

    const timeline = await (
      await api(timelineUrl(monitor.id, { since: HOUR, until: HOUR + 10 * MINUTE, buckets: 10 }))
    ).json<MonitorTimeline>();

    expect(timeline.buckets.map(({ status, value }) => [status, value])).toEqual([
      ["unknown", null],
      ["ok", 2],
      ["medium", 7],
      ["high", 12],
    ]);
  });

  it("accepts 500 buckets and refuses more", async () => {
    const monitor = await signalMonitor({
      type: "metric",
      config: { windowSeconds: 300, threshold: 10 },
    });

    const range = { since: HOUR, until: HOUR + 600 * MINUTE };

    expect((await api(timelineUrl(monitor.id, { ...range, buckets: 500 }))).status).toBe(200);
    expect((await api(timelineUrl(monitor.id, { ...range, buckets: 501 }))).status).toBe(400);
  });
});

describe("monitor members", () => {
  it("lists the organization's members to a member who is not an owner, for assignee names", async () => {
    const member = await addMember(1);

    const response = await api("/organizations/default/monitor-members/", { email: member.email });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ userId: member.id, email: member.email })]),
    );
  });
});

describe("a monitor's creator", () => {
  it("names the member who created it, and a former member once that user is deleted", async () => {
    const { id: projectId } = await createProject();
    const { id: userId } = await addMember(1);
    const store = new MonitorStore(env.DB);

    const monitor = await store.create(
      1,
      CreateMonitor.parse({
        projectId,
        name: "Created",
        type: "metric",
        config: { windowSeconds: 300, threshold: 10 },
      }),
      { userId, time: HOUR, requestKey: null },
    );

    if (monitor === null) {
      throw new Error("monitor was not created");
    }

    expect(monitor.creator).toEqual({ kind: "member", userId });

    await env.DB.prepare("DELETE FROM users WHERE id = ?1").bind(userId).run();

    expect((await store.find(1, monitor.id))?.creator).toEqual({ kind: "former_member" });
  });
});

describe("routing a monitor's transitions", () => {
  it("routes a scope's earlier transitions first, so a high-priority recovery knows it paged", async () => {
    const { id: projectId } = await createProject();
    const slug = `paged-${crypto.randomUUID().slice(0, 8)}`;

    const rule = await (
      await api("/organizations/default/monitor-alert-rules/", {
        method: "POST",
        body: {
          name: "High only",
          channels: ["email"],
          triggers: ["failure", "recovery"],
          audience: { kind: "project" },
          priority: "high",
        },
      })
    ).json<ApiMonitorRule>();

    const monitor = await (
      await api("/organizations/default/monitors/", {
        method: "POST",
        body: {
          projectId,
          type: "cron",
          name: "Paged export",
          alertRuleIds: [rule.id],
          notify: true,
          config: { slug, schedule: { type: "crontab", crontab: "0 * * * *" } },
        },
      })
    ).json<ApiMonitor>();

    await missTheNextRun({ projectId, monitor, rule });

    const store = new CronStore(env.DB);

    const recovered = CheckIn.parse({
      check_in_id: crypto.randomUUID(),
      monitor_slug: slug,
      status: "ok",
    });

    await receiveCheckIn(store, { projectId, checkIn: recovered, now: HOUR + 65 * MINUTE });

    const { results: transitions } = await env.DB.prepare(
      "SELECT id, type FROM monitor_transitions WHERE monitor_id = ?1 ORDER BY id",
    )
      .bind(monitor.id)
      .all<{ id: number; type: string }>();

    expect(transitions.map(({ type }) => type)).toEqual(["failure", "recovery"]);

    // Routing the recovery first routes the failure before it.
    const recovery = transitions[1];

    if (recovery === undefined) {
      throw new Error("no recovery transition");
    }

    await routeTransitions(new MonitorRoutingStore(env.DB), recovery.id, HOUR + 66 * MINUTE);

    const { results: deliveries } = await env.DB.prepare(
      `SELECT transition_type AS type, suppression FROM monitor_deliveries
       WHERE rule_id = ?1 ORDER BY id`,
    )
      .bind(rule.id)
      .all<{ type: string; suppression: string | null }>();

    expect(deliveries).toEqual([
      { type: "failure", suppression: null },
      { type: "recovery", suppression: null },
    ]);
  });
});
