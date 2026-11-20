import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { evaluateCronDeadlines } from "@/cron/cron-deadlines";
import { CronStore } from "@/db/cron-store";
import { MonitorStore } from "@/db/monitors";
import { receiveCheckIn } from "@/ingest/cron-receive";
import { CheckIn, CreateMonitor } from "@/shared/monitors";
import type { ApiMonitor, CronSettingsInput, WireCheckIn } from "@/shared/monitors";
import { MINUTE } from "@/shared/time";

import { createOrganization, createProject, groupsOf, NOW } from "./helpers";
import { addMember } from "./notify-helpers";

// The top of an hour, so hourly schedules line up with the offsets below.
const T0 = Math.floor(NOW / (60 * MINUTE)) * 60 * MINUTE;

type Fixture = { projectId: number; organizationId: number; userId: number; monitor: ApiMonitor };

async function hourlyMonitor(config: Partial<CronSettingsInput> = {}): Promise<Fixture> {
  const organizationId = await createOrganization(1_000_000);
  const { id: projectId } = await createProject(null, organizationId);
  const { id: userId } = await addMember(organizationId);

  const monitor = await new MonitorStore(env.DB).create(
    organizationId,
    CreateMonitor.parse({
      projectId,
      name: "Nightly export",
      type: "cron",
      config: {
        slug: "nightly-export",
        schedule: { type: "crontab", crontab: "0 * * * *" },
        ...config,
      },
    }),
    { userId, time: T0, requestKey: null },
  );

  if (monitor === null) {
    throw new Error("monitor was not created");
  }

  return { projectId, organizationId, userId, monitor };
}

const store = new CronStore(env.DB);

function checkIn(fields: Partial<WireCheckIn>) {
  return CheckIn.parse({
    check_in_id: crypto.randomUUID(),
    monitor_slug: "nightly-export",
    ...fields,
  });
}

async function rows(monitorId: string) {
  return new MonitorStore(env.DB).timeline.checkIns(monitorId);
}

async function scopes(monitorId: string) {
  return new MonitorStore(env.DB).timeline.scopes(monitorId);
}

describe("cron check-ins", () => {
  it("finds the monitor from the SDK's unslugged name and records both reports of a run", async () => {
    const { projectId, monitor } = await hourlyMonitor();
    const run = crypto.randomUUID();

    await receiveCheckIn(store, {
      projectId,
      checkIn: checkIn({ check_in_id: run, monitor_slug: "Nightly Export", status: "in_progress" }),
      now: T0,
    });
    await receiveCheckIn(store, {
      projectId,
      checkIn: checkIn({ check_in_id: run, status: "ok", duration: 2.5 }),
      now: T0 + MINUTE,
    });

    expect(await rows(monitor.id)).toEqual([
      expect.objectContaining({
        status: "ok",
        startedAt: T0,
        completedAt: T0 + MINUTE,
        durationMs: 2500,
      }),
    ]);
    expect(await scopes(monitor.id)).toEqual([
      expect.objectContaining({
        environment: "production",
        health: "healthy",
        nextAt: T0 + 60 * MINUTE,
      }),
    ]);
  });

  it("keeps a heartbeat that ends after the margin, and records the miss before it", async () => {
    const { projectId, monitor } = await hourlyMonitor();

    await receiveCheckIn(store, { projectId, checkIn: checkIn({ status: "ok" }), now: T0 });
    // The next run's only report arrives 10 minutes late, after the miss.
    await evaluateCronDeadlines(store, T0 + 61 * MINUTE);
    await receiveCheckIn(store, {
      projectId,
      checkIn: checkIn({ status: "ok" }),
      now: T0 + 70 * MINUTE,
    });

    expect((await rows(monitor.id)).map(({ status }) => status)).toEqual(["ok", "missed", "ok"]);
    expect(await scopes(monitor.id)).toEqual([
      expect.objectContaining({ health: "healthy", nextAt: T0 + 120 * MINUTE }),
    ]);

    // The miss opened an issue and the late success resolved it.
    expect(await groupsOf(projectId)).toEqual([expect.objectContaining({ status: "resolved" })]);
  });

  it("treats a duplicate report as a no-op", async () => {
    const { projectId, monitor } = await hourlyMonitor();
    const report = checkIn({ status: "error" });

    await receiveCheckIn(store, { projectId, checkIn: report, now: T0 });
    await receiveCheckIn(store, { projectId, checkIn: report, now: T0 + 1000 });

    expect(await rows(monitor.id)).toHaveLength(1);
    expect(await groupsOf(projectId)).toEqual([
      expect.objectContaining({ status: "unresolved", times_seen: 1 }),
    ]);
  });

  it("closes the latest open run for the all-zero check-in ID", async () => {
    const { projectId, monitor } = await hourlyMonitor();

    await receiveCheckIn(store, {
      projectId,
      checkIn: checkIn({ status: "in_progress" }),
      now: T0,
    });
    await receiveCheckIn(store, {
      projectId,
      checkIn: checkIn({ check_in_id: "0".repeat(32), status: "error" }),
      now: T0 + MINUTE,
    });

    expect(await rows(monitor.id)).toEqual([
      expect.objectContaining({ status: "error", startedAt: T0 }),
    ]);
  });

  it("times out a run past its runtime and keeps the timeout when it finishes", async () => {
    const { projectId, monitor } = await hourlyMonitor({ maxRuntimeMinutes: 5 });
    const run = crypto.randomUUID();

    await receiveCheckIn(store, {
      projectId,
      checkIn: checkIn({ check_in_id: run, status: "in_progress" }),
      now: T0,
    });
    await evaluateCronDeadlines(store, T0 + 5 * MINUTE);
    await receiveCheckIn(store, {
      projectId,
      checkIn: checkIn({ check_in_id: run, status: "ok" }),
      now: T0 + 7 * MINUTE,
    });

    expect(await rows(monitor.id)).toEqual([
      expect.objectContaining({
        status: "timeout",
        completedAt: T0 + 7 * MINUTE,
        durationMs: 7 * MINUTE,
      }),
    ]);
    expect(await groupsOf(projectId)).toEqual([expect.objectContaining({ status: "unresolved" })]);
  });

  it("tracks environments separately and reports the worst as the monitor's health", async () => {
    const { projectId, organizationId, monitor } = await hourlyMonitor();

    await receiveCheckIn(store, {
      projectId,
      checkIn: checkIn({ status: "ok", environment: "production" }),
      now: T0,
    });
    await receiveCheckIn(store, {
      projectId,
      checkIn: checkIn({ status: "error", environment: "staging" }),
      now: T0,
    });

    expect(await scopes(monitor.id)).toEqual([
      expect.objectContaining({ environment: "production", health: "healthy" }),
      expect.objectContaining({ environment: "staging", health: "failing" }),
    ]);
    expect((await new MonitorStore(env.DB).find(organizationId, monitor.id))?.health).toBe(
      "failing",
    );
  });
});

describe("unrecognized check-ins", () => {
  it("counts a check-in for an unknown slug instead of refusing it", async () => {
    const { projectId, organizationId } = await hourlyMonitor();

    await receiveCheckIn(store, {
      projectId,
      checkIn: checkIn({ monitor_slug: "typo", status: "ok" }),
      now: T0,
    });
    await receiveCheckIn(store, {
      projectId,
      checkIn: checkIn({ monitor_slug: "typo", status: "ok" }),
      now: T0 + MINUTE,
    });

    expect(await new MonitorStore(env.DB).timeline.unrecognized(organizationId)).toEqual([
      expect.objectContaining({
        slug: "typo",
        environment: "production",
        reason: "unknown_slug",
        count: 2,
      }),
    ]);
  });

  it("creates a monitor from the SDK's monitor_config the first time its slug is seen", async () => {
    const { projectId, organizationId } = await hourlyMonitor();

    await receiveCheckIn(store, {
      projectId,
      checkIn: checkIn({
        monitor_slug: "Billing Sync",
        status: "in_progress",
        monitor_config: {
          schedule: { type: "interval", value: 15, unit: "minute" },
          checkin_margin: 0,
          max_runtime: 99_999,
          timezone: "Europe/London",
        },
      }),
      now: T0,
    });

    const created = (await new MonitorStore(env.DB).list(organizationId, { kind: "all" })).find(
      ({ name }) => name === "billing-sync",
    );

    expect(created?.config).toEqual({
      slug: "billing-sync",
      schedule: { type: "interval", count: 15, unit: "minute" },
      timezone: "Europe/London",
      // Clamped as Sentry clamps them.
      graceMinutes: 1,
      maxRuntimeMinutes: 10_080,
      failureThreshold: 1,
      recoveryThreshold: 1,
    });
    expect(created?.creator).toEqual({ kind: "sdk" });
  });

  it("updates an existing monitor from monitor_config, as Sentry upserts it", async () => {
    const { projectId, organizationId, monitor } = await hourlyMonitor({ failureThreshold: 3 });

    await receiveCheckIn(store, { projectId, checkIn: checkIn({ status: "ok" }), now: T0 });
    await receiveCheckIn(store, {
      projectId,
      checkIn: checkIn({
        status: "in_progress",
        monitor_config: {
          schedule: { type: "crontab", value: "30 * * * *" },
          checkin_margin: 5,
        },
      }),
      now: T0 + 10 * MINUTE,
    });

    const updated = (await new MonitorStore(env.DB).list(organizationId, { kind: "all" })).find(
      ({ id }) => id === monitor.id,
    );

    expect(updated?.version).toBe(monitor.version + 1);
    expect(updated?.config).toEqual({
      ...monitor.config,
      schedule: { type: "crontab", crontab: "30 * * * *" },
      graceMinutes: 5,
      // Not sent by the SDK, so the value set on the monitor stays.
      failureThreshold: 3,
    });
    // The check-in that carried the change is planned under the new schedule.
    expect(await scopes(monitor.id)).toEqual([
      expect.objectContaining({ nextAt: T0 + 30 * MINUTE }),
    ]);
  });

  it("leaves the monitor's version alone when monitor_config matches it", async () => {
    const { projectId, organizationId, monitor } = await hourlyMonitor();

    await receiveCheckIn(store, {
      projectId,
      checkIn: checkIn({
        status: "ok",
        monitor_config: { schedule: { type: "crontab", value: "0 * * * *" } },
      }),
      now: T0,
    });

    const listed = (await new MonitorStore(env.DB).list(organizationId, { kind: "all" })).find(
      ({ id }) => id === monitor.id,
    );

    expect(listed?.version).toBe(monitor.version);
  });

  it("keeps the monitor and records the check-in when monitor_config is out of bounds", async () => {
    const { projectId, organizationId, monitor } = await hourlyMonitor();

    await receiveCheckIn(store, {
      projectId,
      checkIn: checkIn({
        status: "ok",
        monitor_config: { schedule: { type: "crontab", value: "not a schedule" } },
      }),
      now: T0,
    });

    const listed = (await new MonitorStore(env.DB).list(organizationId, { kind: "all" })).find(
      ({ id }) => id === monitor.id,
    );

    expect(listed?.config).toEqual(monitor.config);
    expect((await rows(monitor.id)).map(({ status }) => status)).toEqual(["ok"]);
  });

  it("re-plans every environment when monitor_config changes the timing", async () => {
    const { projectId, monitor } = await hourlyMonitor();

    await receiveCheckIn(store, {
      projectId,
      checkIn: checkIn({ status: "ok", environment: "staging" }),
      now: T0,
    });
    // Production carries the new schedule; staging must follow it without its own check-in.
    await receiveCheckIn(store, {
      projectId,
      checkIn: checkIn({
        status: "ok",
        environment: "production",
        monitor_config: { schedule: { type: "crontab", value: "30 * * * *" } },
      }),
      now: T0 + 10 * MINUTE,
    });

    const byEnvironment = Object.fromEntries(
      (await scopes(monitor.id)).map((scope) => [scope.environment, scope.nextAt]),
    );

    expect(byEnvironment).toEqual({ production: T0 + 30 * MINUTE, staging: T0 + 30 * MINUTE });
  });

  it("keeps the monitor and records the check-in when monitor_config is malformed", async () => {
    const { projectId, organizationId, monitor } = await hourlyMonitor();

    await receiveCheckIn(store, {
      projectId,
      checkIn: CheckIn.parse({
        check_in_id: crypto.randomUUID(),
        monitor_slug: "nightly-export",
        status: "ok",
        monitor_config: { schedule: { type: "fortnightly" } },
      }),
      now: T0,
    });

    const listed = (await new MonitorStore(env.DB).list(organizationId, { kind: "all" })).find(
      ({ id }) => id === monitor.id,
    );

    expect(listed?.version).toBe(monitor.version);
    expect((await rows(monitor.id)).map(({ status }) => status)).toEqual(["ok"]);
  });

  it("loses to a UI edit that bumped the version first", async () => {
    const { projectId, userId, monitor } = await hourlyMonitor();
    const monitors = new MonitorStore(env.DB);

    // An environment with a check-in, so a re-plan that slipped past the fence would show.
    await receiveCheckIn(store, { projectId, checkIn: checkIn({ status: "ok" }), now: T0 });
    const read = await store.find(projectId, "nightly-export");

    if (read === null) {
      throw new Error("monitor not found");
    }

    await monitors.edit(monitor, {
      version: monitor.version,
      userId,
      time: T0,
      replan: null,
      monitor: CreateMonitor.parse({
        projectId,
        name: "Renamed",
        type: "cron",
        config: { ...monitor.config, failureThreshold: 2 },
      }),
    });

    const before = await scopes(monitor.id);

    // A reconfiguration planned against the pre-edit read must not overwrite the edit, and its
    // re-plan must be fenced out with it rather than moving the environments on its own.
    await store.reconfigure(read, {
      config: { ...read.config, schedule: { type: "crontab", crontab: "30 * * * *" } },
      replan: { nextCheckIn: T0 + 999 * MINUTE, nextCheckInLatest: T0 + 1000 * MINUTE },
      now: T0,
    });

    const after = await store.find(projectId, "nightly-export");

    expect(after?.config.schedule).toEqual({ type: "crontab", crontab: "0 * * * *" });
    expect(after?.config.failureThreshold).toBe(2);
    expect(before).toHaveLength(1);
    expect(await scopes(monitor.id)).toEqual(before);
  });

  it("does not record check-ins for a paused monitor", async () => {
    const { projectId, organizationId, userId, monitor } = await hourlyMonitor();

    await new MonitorStore(env.DB).setStatus(monitor.id, {
      status: "paused",
      version: monitor.version,
      userId,
      time: T0,
      replan: null,
    });
    await receiveCheckIn(store, { projectId, checkIn: checkIn({ status: "error" }), now: T0 });

    expect(await rows(monitor.id)).toEqual([]);
    expect(await new MonitorStore(env.DB).timeline.unrecognized(organizationId)).toEqual([
      expect.objectContaining({ reason: "inactive" }),
    ]);
  });
});

describe("editing a cron monitor", () => {
  it("keeps the open incident and re-plans the next check-in from now", async () => {
    const { projectId, userId, monitor } = await hourlyMonitor();
    const monitors = new MonitorStore(env.DB);

    await receiveCheckIn(store, { projectId, checkIn: checkIn({ status: "error" }), now: T0 });

    const edited = await monitors.edit(monitor, {
      version: monitor.version,
      userId,
      time: T0 + 5 * MINUTE,
      // What the API computes for "30 * * * *" from the edit time.
      replan: { nextCheckIn: T0 + 30 * MINUTE, nextCheckInLatest: T0 + 35 * MINUTE },
      monitor: CreateMonitor.parse({
        projectId,
        name: monitor.name,
        type: "cron",
        config: {
          ...monitor.config,
          schedule: { type: "crontab", crontab: "30 * * * *" },
          graceMinutes: 5,
        },
      }),
    });

    expect(edited?.version).toBe(monitor.version + 1);
    expect(await groupsOf(projectId)).toEqual([expect.objectContaining({ status: "unresolved" })]);
    expect(await scopes(monitor.id)).toEqual([
      expect.objectContaining({ health: "failing", nextAt: T0 + 30 * MINUTE }),
    ]);
  });

  it("expects a resumed monitor's next check-in from the resume, not from before the pause", async () => {
    const { projectId, userId, monitor } = await hourlyMonitor();
    const monitors = new MonitorStore(env.DB);
    const resumedAt = T0 + 120 * MINUTE;

    await receiveCheckIn(store, { projectId, checkIn: checkIn({ status: "ok" }), now: T0 });

    const paused = await monitors.setStatus(monitor.id, {
      status: "paused",
      version: monitor.version,
      userId,
      time: T0,
      replan: null,
    });

    if (paused === null) {
      throw new Error("monitor was not paused");
    }

    // What the API plans for "0 * * * *" with a one-minute margin.
    const plan = { nextCheckIn: T0 + 180 * MINUTE, nextCheckInLatest: T0 + 181 * MINUTE };

    await monitors.setStatus(monitor.id, {
      status: "active",
      version: paused.version,
      userId,
      time: resumedAt,
      replan: plan,
    });

    // The hours while paused are not missed; the first slot after resuming is.
    await evaluateCronDeadlines(store, resumedAt + 30 * MINUTE);
    expect((await rows(monitor.id)).map(({ status }) => status)).toEqual(["ok"]);

    await evaluateCronDeadlines(store, T0 + 181 * MINUTE);
    expect((await rows(monitor.id)).map(({ status }) => status)).toEqual(["missed", "ok"]);
  });

  it("leaves environments alone when a stale edit or resume loses its version check", async () => {
    const { projectId, userId, monitor } = await hourlyMonitor();
    const monitors = new MonitorStore(env.DB);

    await receiveCheckIn(store, { projectId, checkIn: checkIn({ status: "error" }), now: T0 });

    const renamed = await monitors.edit(monitor, {
      version: monitor.version,
      userId,
      time: T0,
      replan: null,
      monitor: CreateMonitor.parse({
        projectId,
        name: "Renamed",
        type: "cron",
        config: monitor.config,
      }),
    });

    expect(renamed?.version).toBe(monitor.version + 1);

    // A second tab still holding the original version.
    const staleEdit = await monitors.edit(monitor, {
      version: monitor.version,
      userId,
      time: T0,
      replan: { nextCheckIn: T0 + 999 * MINUTE, nextCheckInLatest: T0 + 1000 * MINUTE },
      monitor: CreateMonitor.parse({
        projectId,
        name: "Stale",
        type: "cron",
        config: monitor.config,
      }),
    });

    const staleResume = await monitors.setStatus(monitor.id, {
      status: "paused",
      version: monitor.version,
      userId,
      time: T0,
      replan: { nextCheckIn: T0 + 999 * MINUTE, nextCheckInLatest: T0 + 1000 * MINUTE },
    });

    expect(staleEdit).toBeNull();
    expect(staleResume).toBeNull();
    expect(await scopes(monitor.id)).toEqual([
      expect.objectContaining({ health: "failing", nextAt: T0 + 60 * MINUTE }),
    ]);
  });
});
