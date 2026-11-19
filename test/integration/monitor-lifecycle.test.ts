import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { evaluateCronDeadlines } from "@/cron/cron-deadlines";
import { CronStore } from "@/db/cron-store";
import { MetricEvaluationStore } from "@/db/metric-evaluation";
import { MonitorRoutingStore } from "@/db/monitor-routing";
import { MonitorStore } from "@/db/monitors";
import { receiveCheckIn } from "@/ingest/cron-receive";
import { routeTransitions } from "@/notify/monitor-routing";
import type { Json } from "@/shared/contract";
import { CheckIn, CreateMonitor } from "@/shared/monitors";
import type { ApiMonitor } from "@/shared/monitors";
import { MINUTE } from "@/shared/time";

import { createProject, NOW } from "./helpers";
import { addMember } from "./notify-helpers";

const HOUR = Math.floor(NOW / (60 * MINUTE)) * 60 * MINUTE;

const monitors = new MonitorStore(env.DB);

type Fixture = { projectId: number; userId: number; monitor: ApiMonitor };

async function create(input: Json): Promise<Fixture> {
  const { id: projectId } = await createProject();
  const { id: userId } = await addMember(1);

  const monitor = await monitors.create(
    1,
    CreateMonitor.parse({ projectId, name: "Lifecycle", ...Object(input) }),
    { userId, time: HOUR, requestKey: null },
  );

  if (monitor === null) {
    throw new Error("monitor was not created");
  }

  return { projectId, userId, monitor };
}

/** An hourly cron monitor whose 11:00 run was missed, so its issue is open. */
async function failingCron(): Promise<Fixture> {
  const slug = `job-${crypto.randomUUID().slice(0, 8)}`;

  const fixture = await create({
    type: "cron",
    config: { slug, schedule: { type: "crontab", crontab: "0 * * * *" } },
  });

  const store = new CronStore(env.DB);

  await receiveCheckIn(store, {
    projectId: fixture.projectId,
    checkIn: CheckIn.parse({ check_in_id: crypto.randomUUID(), monitor_slug: slug, status: "ok" }),
    now: HOUR + 30 * MINUTE,
  });
  await evaluateCronDeadlines(store, HOUR + 62 * MINUTE);

  return fixture;
}

async function incident(monitorId: string) {
  return env.DB.prepare(
    `SELECT g.status, p.closed_at AS closedAt, p.disposition FROM groups g
     JOIN monitor_periods p ON p.group_id = g.id WHERE g.monitor_id = ?1 ORDER BY p.id DESC`,
  )
    .bind(monitorId)
    .first<{ status: string; closedAt: number | null; disposition: string | null }>();
}

describe("ending a monitor's incident", () => {
  it("closes it without an alert when the monitor is archived", async () => {
    const { monitor, userId } = await failingCron();

    expect(await incident(monitor.id)).toMatchObject({ status: "unresolved", closedAt: null });

    const archived = await monitors.setStatus(monitor.id, {
      version: monitor.version,
      userId,
      time: HOUR + 70 * MINUTE,
      status: "archived",
      replan: null,
    });

    expect(archived?.status).toBe("archived");
    expect(await incident(monitor.id)).toEqual({
      status: "resolved",
      closedAt: HOUR + 70 * MINUTE,
      disposition: "configuration_changed",
    });

    const recoveries = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM monitor_transitions WHERE monitor_id = ?1 AND type = 'recovery'",
    )
      .bind(monitor.id)
      .first<{ count: number }>();

    expect(recoveries?.count).toBe(0);
  });

  it("keeps it open when the monitor is paused", async () => {
    const { monitor, userId } = await failingCron();

    await monitors.setStatus(monitor.id, {
      version: monitor.version,
      userId,
      time: HOUR + 70 * MINUTE,
      status: "paused",
      replan: null,
    });

    expect(await incident(monitor.id)).toMatchObject({ status: "unresolved", closedAt: null });
  });

  it("closes a metric monitor's incident when its threshold changes", async () => {
    const { monitor, userId } = await create({
      type: "metric",
      config: { windowSeconds: 300, threshold: 10 },
    });

    // An open issue and period, as a failing window leaves them.
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO groups (project_id, short_id, primary_hash, title, level, metadata, status,
           times_seen, first_seen, last_seen, created_at, monitor_id, monitor_scope)
         SELECT project_id, 900000 + abs(random() % 99999), 'monitor:' || id || ':', name, 'error', '{}',
           'unresolved', 1, ?2, ?2, ?2, id, '' FROM monitors WHERE id = ?1`,
      ).bind(monitor.id, HOUR),
      env.DB.prepare(
        `INSERT INTO monitor_periods (group_id, opened_at, evidence)
         SELECT id, ?2, '{}' FROM groups WHERE monitor_id = ?1`,
      ).bind(monitor.id, HOUR),
    ]);

    if (monitor.type !== "metric") {
      throw new Error("expected a metric monitor");
    }

    await monitors.edit(monitor, {
      version: monitor.version,
      userId,
      time: HOUR + 5 * MINUTE,
      replan: null,
      monitor: {
        projectId: monitor.projectId,
        name: monitor.name,
        description: "",
        ownerId: null,
        alertRuleIds: [],
        notify: false,
        type: "metric",
        config: { ...monitor.config, threshold: 20 },
      },
    });

    expect(await incident(monitor.id)).toEqual({
      status: "resolved",
      closedAt: HOUR + 5 * MINUTE,
      disposition: "configuration_changed",
    });
  });
});

describe("a metric window", () => {
  it("is discarded when the monitor is edited between its read and its write", async () => {
    const { monitor } = await create({
      type: "metric",
      config: { windowSeconds: 300, threshold: 1 },
    });

    const store = new MetricEvaluationStore(env.DB);
    const windowEnd = HOUR + 10 * MINUTE;

    const decision = (await store.due(windowEnd)).find(({ monitorId }) => monitorId === monitor.id);

    if (decision === undefined) {
      throw new Error("the monitor was not due");
    }

    // An edit resets evaluated_at to NULL, as it was, and bumps the generation.
    await env.DB.prepare("UPDATE monitors SET generation = generation + 1 WHERE id = ?1")
      .bind(monitor.id)
      .run();
    await store.write(windowEnd, [
      { decision, plan: { state: { issue: null, periodOpen: false }, changes: [null] } },
    ]);

    const after = await env.DB.prepare(
      `SELECT evaluated_at AS evaluatedAt,
         (SELECT COUNT(*) FROM monitor_observations WHERE monitor_id = ?1) AS observations
       FROM monitors WHERE id = ?1`,
    )
      .bind(monitor.id)
      .first<{ evaluatedAt: number | null; observations: number }>();

    expect(after).toEqual({ evaluatedAt: null, observations: 0 });
  });
});

describe("routing a scope's transitions", () => {
  it("skips an earlier transition whose outbox row was dropped, so it cannot silence the scope", async () => {
    const { monitor } = await failingCron();

    const failure = await env.DB.prepare("SELECT id FROM monitor_transitions WHERE monitor_id = ?1")
      .bind(monitor.id)
      .first<{ id: number }>();

    if (failure === null) {
      throw new Error("no failure transition");
    }

    // The failure's row failed too often and was dropped; a later transition arrives.
    await env.DB.prepare(
      "DELETE FROM notify_outbox WHERE json_extract(data, '$.monitorTransitionId') = ?1",
    )
      .bind(failure.id)
      .run();

    const later = await env.DB.prepare(
      `INSERT INTO monitor_transitions (generation, monitor_id, scope, happened_at, type, evidence)
       VALUES (1, ?1, 'production', ?2, 'recovery', '{"severity":"high"}') RETURNING id`,
    )
      .bind(monitor.id, HOUR + 90 * MINUTE)
      .first<{ id: number }>();

    if (later === null) {
      throw new Error("no later transition");
    }

    await routeTransitions(new MonitorRoutingStore(env.DB), later.id, HOUR + 91 * MINUTE);

    const { results } = await env.DB.prepare(
      "SELECT id, routed_at AS routedAt FROM monitor_transitions WHERE monitor_id = ?1 ORDER BY id",
    )
      .bind(monitor.id)
      .all<{ id: number; routedAt: number | null }>();

    expect(results).toEqual([
      { id: failure.id, routedAt: null },
      { id: later.id, routedAt: HOUR + 91 * MINUTE },
    ]);
  });
});
