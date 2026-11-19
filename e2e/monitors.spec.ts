import { unlink, writeFile } from "node:fs/promises";
import { setTimeout as wait } from "node:timers/promises";

import type { ApiMonitor, MonitorDetail, MonitorHistory, MonitorPreviewJob } from "@contract";
import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";
import * as Sentry from "@sentry/node";

import captured from "./python-sentry-checkins.json" with { type: "json" };
import { clickAndSend, contractJson, newProject, openShop, waitForIssues } from "./support";
import type { Fixture } from "./support";
import { ORG, SHOP_URL } from "./urls";

test.describe.configure({ mode: "default" });

const MONITORS = `/api/0/organizations/${ORG}/monitors/`;

test("an owner creates and lists a metric monitor for their project", async ({ request }) => {
  const { project } = await newProject(request, "Metric monitors");

  const input = {
    projectId: project.id,
    name: "Errors in production",
    type: "metric",
    config: { windowSeconds: 300, threshold: 10, environment: "production" },
  };

  const created = await request.post(MONITORS, { data: input });
  expect(created.status(), "create monitor").toBe(201);
  await expect(created.json()).resolves.toMatchObject({
    ...input,
    status: "active",
    health: "awaiting_data",
  });

  const list = await request.get(MONITORS, { params: { project: project.id } });
  expect(list.ok()).toBe(true);
  await expect(list.json()).resolves.toEqual([await created.json()]);
});

test("covered metric windows filter SDK errors and open at medium priority", async ({
  page,
  request,
}) => {
  test.setTimeout(150_000);
  const fixture = await newProject(request, "Metric tiers");

  const created = await request.post(MONITORS, {
    data: {
      projectId: fixture.project.id,
      name: "Production errors",
      type: "metric",
      config: {
        windowSeconds: 300,
        threshold: 2,
        warningThreshold: 1,
        environment: "production",
        level: "error",
      },
    },
  });

  expect(created.status(), await created.text()).toBe(201);
  // Coverage starts a minute after the monitor, once every ingest isolate's
  // cached list of captured projects has had time to include this project.
  const firstCoveredMinute = Math.ceil((Date.now() + 60_000) / 60_000) * 60_000;
  await wait(Math.max(0, firstCoveredMinute + 50 - Date.now()));

  await openShop(page, fixture, { environment: "production" });
  expect((await clickAndSend(page, "apply-discount")).ok()).toBe(true);
  await waitForIssues(request, fixture, { issues: 1, events: 1 });

  await tick(request, firstCoveredMinute + 7 * 60_000);

  const list = await request.get(MONITORS, { params: { project: fixture.project.id } });

  await expect(list.json()).resolves.toMatchObject([{ health: "failing", severity: "medium" }]);
});

test("an SDK check-in changes the health of its configured cron monitor", async ({ request }) => {
  const fixture = await newProject(request, "Cron check-ins");

  const created = await request.post(MONITORS, {
    data: {
      projectId: fixture.project.id,
      name: "Nightly import",
      type: "cron",
      config: { slug: "nightly", schedule: { type: "crontab", crontab: "0 3 * * *" } },
    },
  });

  expect(created.status()).toBe(201);

  const payload = JSON.stringify({
    check_in_id: crypto.randomUUID().replaceAll("-", ""),
    monitor_slug: "nightly",
    environment: "production",
    status: "ok",
  });

  const dsn = new URL(fixture.key.dsn);

  const accepted = await request.post(`/api/${fixture.project.id}/envelope/`, {
    data: [JSON.stringify({ dsn: dsn.href }), JSON.stringify({ type: "check_in" }), payload].join(
      "\n",
    ),
  });

  expect(accepted.ok()).toBe(true);

  const list = await request.get(MONITORS, { params: { project: fixture.project.id } });

  await expect(list.json()).resolves.toMatchObject([{ type: "cron", health: "healthy" }]);
});

test("an uptime monitor runs a probe of an approved endpoint", async ({ request }) => {
  const { project } = await newProject(request, "Uptime checks");

  const input = {
    projectId: project.id,
    name: "Fixture service",
    type: "uptime",
    config: { url: `${SHOP_URL}/`, intervalMinutes: 1 },
  };

  const denied = await request.post(MONITORS, {
    data: { ...input, config: { ...input.config, url: "http://localhost:1/" } },
  });

  expect(denied.status()).toBe(400);

  const created = await request.post(MONITORS, { data: input });

  expect(created.status()).toBe(201);

  const scheduled = await request.get("/cdn-cgi/local/scheduled", {
    params: { cron: "* * * * *", time: Date.now() + 120_000, format: "json" },
  });

  expect(scheduled.ok()).toBe(true);

  await expect
    .poll(async () => {
      const list = await request.get(MONITORS, { params: { project: project.id } });

      return list.json();
    })
    .toMatchObject([{ type: "uptime", health: "healthy" }]);
});

test("the Monitors pages create, edit and disable a metric monitor", async ({ page, request }) => {
  const { project } = await newProject(request, "Monitor UI");

  await page.goto(`/${ORG}/monitors/new/?project=${project.id}`);
  await expect(page.getByRole("radio", { name: /Metric/ })).toBeChecked();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("textbox", { name: "Monitor Name" }).fill("Checkout error count");
  await page.getByLabel("High priority threshold").fill("4");
  await page.getByRole("button", { name: "Create Monitor" }).click();

  await expect(page.getByRole("heading", { name: "Checkout error count" })).toBeVisible();
  await expect(page.getByText("High: Above 4")).toBeVisible();

  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("textbox", { name: "Monitor Name" }).fill("Checkout production errors");
  await page.getByLabel("High priority threshold").fill("9");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Checkout production errors" })).toBeVisible();
  await expect(page.getByText("High: Above 9")).toBeVisible();

  const stale = await request.put(`/api/0/organizations${new URL(page.url()).pathname}`, {
    data: {
      version: 1,
      monitor: {
        projectId: project.id,
        type: "metric",
        name: "Stale edit",
        config: { windowSeconds: 300, threshold: 1 },
      },
    },
  });

  expect(stale.status()).toBe(409);
  await page.getByRole("button", { name: "Disable", exact: true }).click();
  await expect(page.getByText("This monitor is disabled and not creating issues.")).toBeVisible();
  await page.getByRole("button", { name: "Enable", exact: true }).click();
  await expect(page.getByRole("button", { name: "Disable", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Monitors", exact: true }).first().click();
  await expect(page.getByRole("link", { name: "Checkout production errors" })).toBeVisible();
});

test("a cron monitor created in the form waits for its first check-in, then draws it", async ({
  page,
  request,
}) => {
  const fixture = await newProject(request, "Cron UI");

  await page.goto(`/${ORG}/monitors/new/?type=cron&project=${fixture.project.id}`);
  await expect(page.getByRole("radio", { name: /Cron/ })).toBeChecked();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("textbox", { name: "Monitor Name" }).fill("Report Builder");
  // The slug follows the name until it is edited, as Sentry's form.
  await expect(page.getByRole("textbox", { name: "Monitor Slug" })).toHaveValue("report-builder");
  await expect(page.getByLabel("Sample check-ins")).toBeVisible();
  await page.getByRole("button", { name: "Create Monitor" }).click();

  await expect(page.getByRole("heading", { name: "Report Builder" })).toBeVisible();
  await expect(page.getByText(/Waiting for first check-in/i)).toBeVisible();

  await checkIn(request, fixture, {
    id: crypto.randomUUID(),
    slug: "report-builder",
    status: "ok",
  });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Recent Check-Ins" })).toBeVisible();
  await expect(page.getByText("Okay", { exact: true })).toBeVisible();
});

async function tick(request: APIRequestContext, time: number): Promise<void> {
  const scheduled = await request.get("/cdn-cgi/local/scheduled", {
    params: { cron: "* * * * *", time, format: "json" },
  });

  expect(scheduled.ok(), await scheduled.text()).toBe(true);
}

async function checkIn(
  request: APIRequestContext,
  fixture: Fixture,
  data: {
    id: string;
    slug: string;
    status: "in_progress" | "ok" | "error";
    environment?: string;
    duration?: number;
  },
): Promise<void> {
  const items = [
    { dsn: fixture.key.dsn },
    { type: "check_in" },
    {
      check_in_id: data.id,
      monitor_slug: data.slug,
      status: data.status,
      environment: data.environment ?? "production",
      duration: data.duration,
    },
  ];

  const response = await request.post(`/api/${fixture.project.id}/envelope/`, {
    data: items.map((item) => JSON.stringify(item)).join("\n"),
  });

  expect(response.ok(), await response.text()).toBe(true);
}

test("a failed run opens a cron issue once and the next successful run resolves it", async ({
  request,
}) => {
  const fixture = await newProject(request, "Cron recovery");

  const created = await request.post(MONITORS, {
    data: {
      projectId: fixture.project.id,
      name: "Export",
      type: "cron",
      config: { slug: "export", schedule: { type: "interval", count: 1, unit: "hour" } },
    },
  });

  expect(created.status(), await created.text()).toBe(201);
  const { id } = await contractJson<ApiMonitor>(created);

  const run = { id: crypto.randomUUID(), slug: "export" };
  await checkIn(request, fixture, { ...run, status: "in_progress" });
  await checkIn(request, fixture, { ...run, status: "error" });
  // An SDK retry of the same result changes nothing.
  await checkIn(request, fixture, { ...run, status: "error" });
  const [open] = await waitForIssues(request, fixture, { issues: 1, events: 1 });

  expect(open).toMatchObject({ status: "unresolved", title: "Export" });

  // A run is recorded whenever it reports; there is no window it must land in.
  await checkIn(request, fixture, { ...run, id: crypto.randomUUID(), status: "ok" });

  const [resolved] = await waitForIssues(request, fixture, { issues: 1, events: 1 });
  expect(resolved).toMatchObject({ id: open?.id, status: "resolved" });

  // The issue's incident period opened on the failure and closed on recovery.
  const detail = await contractJson<MonitorDetail>(await request.get(`${MONITORS}${id}/`));
  const [period] = detail.incidents;

  expect(detail.incidents).toHaveLength(1);
  expect(period?.disposition).toBe("recovered");
  expect(period?.closedAt).toBeGreaterThanOrEqual(period?.openedAt ?? Number.POSITIVE_INFINITY);
});

test("cron detects a missed schedule and a run that exceeds its runtime", async ({ request }) => {
  const fixture = await newProject(request, "Cron deadlines");

  for (const slug of ["missing", "running"]) {
    const created = await request.post(MONITORS, {
      data: {
        projectId: fixture.project.id,
        name: slug,
        type: "cron",
        config: {
          slug,
          schedule: { type: "interval", count: slug === "missing" ? 1 : 60, unit: "minute" },
          maxRuntimeMinutes: 1,
        },
      },
    });

    expect(created.status(), await created.text()).toBe(201);
    await checkIn(request, fixture, {
      id: crypto.randomUUID(),
      slug,
      status: slug === "missing" ? "ok" : "in_progress",
    });
  }

  await tick(request, Date.now() + 121_000);
  const list = await request.get(MONITORS, { params: { project: fixture.project.id } });

  await expect(list.json()).resolves.toMatchObject([{ health: "failing" }, { health: "failing" }]);
});

async function expectHealth(
  request: APIRequestContext,
  projectId: number,
  health: string,
): Promise<void> {
  await expect
    .poll(async () => {
      const response = await request.get(MONITORS, { params: { project: projectId } });

      return response.json();
    })
    .toMatchObject([{ health }]);
}

test("an uptime issue opens once and resolves when the endpoint recovers", async ({ request }) => {
  const { project } = await newProject(request, "Uptime recovery");
  const id = crypto.randomUUID();
  const file = new URL(`../.wrangler/uptime-${id}`, import.meta.url);

  const created = await request.post(MONITORS, {
    data: {
      projectId: project.id,
      name: "Service health",
      type: "uptime",
      config: { url: `${SHOP_URL}/monitor-health/${id}`, intervalMinutes: 1, failureThreshold: 2 },
    },
  });

  expect(created.status(), await created.text()).toBe(201);

  const first = Date.now() + 120_000;
  await tick(request, first);
  await expectHealth(request, project.id, "degraded");
  await tick(request, first);
  await expectHealth(request, project.id, "degraded");
  await tick(request, first + 60_000);
  await expectHealth(request, project.id, "failing");

  await writeFile(file, "{}\n");

  try {
    await tick(request, first + 120_000);
    await expectHealth(request, project.id, "healthy");

    const issues = await request.get(`/api/0/organizations/${ORG}/issues/`, {
      params: { project: project.id, status: "all" },
    });

    await expect(issues.json()).resolves.toMatchObject({
      issues: [{ status: "resolved", title: "Service health", timesSeen: 1 }],
    });
  } finally {
    await unlink(file);
  }
});

test("a rejected check-in does not discard the error in its envelope", async ({ request }) => {
  const fixture = await newProject(request, "Mixed envelope");
  const eventId = crypto.randomUUID().replaceAll("-", "");

  const response = await request.post(`/api/${fixture.project.id}/envelope/`, {
    data: [
      { dsn: fixture.key.dsn, event_id: eventId },
      { type: "event" },
      { event_id: eventId, message: "Keep this error", level: "error" },
      { type: "check_in" },
      { check_in_id: "invalid", monitor_slug: "missing", status: "ok" },
    ]
      .map((item) => JSON.stringify(item))
      .join("\n"),
  });

  expect(response.ok(), await response.text()).toBe(true);
  await waitForIssues(request, fixture, { issues: 1, events: 1 });
});

test("cron creates environments as their check-ins arrive and tracks them separately", async ({
  request,
}) => {
  const fixture = await newProject(request, "Scoped cron");

  const response = await request.post(MONITORS, {
    data: {
      projectId: fixture.project.id,
      name: "Scoped export",
      type: "cron",
      config: { slug: "scoped-export", schedule: { type: "interval", count: 30, unit: "minute" } },
    },
  });

  expect(response.status(), await response.text()).toBe(201);
  const { id } = await contractJson<ApiMonitor>(response);
  const run = { id: crypto.randomUUID(), slug: "scoped-export" };
  await checkIn(request, fixture, { ...run, status: "in_progress" });
  await checkIn(request, fixture, { ...run, status: "error", duration: 61 });
  await checkIn(request, fixture, {
    ...run,
    id: crypto.randomUUID(),
    status: "ok",
    environment: "staging",
  });

  const detail = await request.get(`${MONITORS}${id}/`);

  await expect(detail.json()).resolves.toMatchObject({
    scopes: [
      { environment: "production", health: "failing" },
      { environment: "staging", health: "healthy", issueId: null },
    ],
    checkIns: expect.arrayContaining([
      expect.objectContaining({
        environment: "production",
        status: "error",
        checkInId: run.id.replaceAll("-", ""),
        durationMs: 61_000,
      }),
    ]),
    observations: expect.arrayContaining([
      expect.objectContaining({
        scope: "production",
        evidence: expect.objectContaining({
          outcome: "error",
          checkInId: run.id.replaceAll("-", ""),
        }),
      }),
    ]),
    incidents: [{ scope: "production", closedAt: null }],
  });
});

test("uptime records a skipped slot and resets its consecutive failure count", async ({
  request,
}) => {
  const { project } = await newProject(request, "Skipped uptime");

  const response = await request.post(MONITORS, {
    data: {
      projectId: project.id,
      name: "Outage coverage",
      type: "uptime",
      config: {
        url: `${SHOP_URL}/monitor-health/${crypto.randomUUID()}`,
        intervalMinutes: 1,
        environment: "prod",
        successCodes: [204],
        failureThreshold: 2,
      },
    },
  });

  expect(response.status(), await response.text()).toBe(201);
  const { id } = await contractJson<ApiMonitor>(response);
  const first = Date.now() + 120_000;
  await tick(request, first);
  await expectHealth(request, project.id, "degraded");
  await tick(request, first + 120_000);
  await expect
    .poll(async () => {
      const detail = await request.get(`${MONITORS}${id}/`);

      return detail.json();
    })
    .toMatchObject({
      monitor: { health: "degraded", issueId: null },
      coverage: { successful: 0, failed: 2, unknown: 1 },
    });
});

test("real JavaScript and captured Python SDK envelopes record runs in their environments", async ({
  request,
}) => {
  const fixture = await newProject(request, "Stock SDK check-ins");

  const monitor = await request.post(MONITORS, {
    data: {
      projectId: fixture.project.id,
      type: "cron",
      name: "Stock SDK",
      config: { slug: "stock-sdk", schedule: { type: "interval", count: 1, unit: "hour" } },
    },
  });

  expect(monitor.status(), await monitor.text()).toBe(201);
  const { id } = await contractJson<ApiMonitor>(monitor);

  const client = Sentry.init({
    dsn: fixture.key.dsn,
    environment: "node-sdk",
    defaultIntegrations: false,
  });

  if (client === undefined) {
    throw new Error("Sentry Node SDK did not initialize");
  }

  const runId = Sentry.captureCheckIn({ monitorSlug: "stock-sdk", status: "in_progress" });
  Sentry.captureCheckIn({
    monitorSlug: "stock-sdk",
    checkInId: runId,
    status: "ok",
    duration: 0.25,
  });
  expect(await client.close(5000)).toBe(true);

  // Serialized by sentry-sdk 2.75.0's Transport.capture_envelope, without
  // modifying or rebuilding the item headers, including their byte lengths.
  const dsn = new URL(fixture.key.dsn);

  for (const envelope of captured) {
    const response = await request.post(`/api/${fixture.project.id}/envelope/`, {
      data: envelope,
      headers: { "x-sentry-auth": `Sentry sentry_key=${dsn.username}` },
    });

    expect(response.ok(), await response.text()).toBe(true);
  }

  const detail = await request.get(`${MONITORS}${id}/`);

  await expect(detail.json()).resolves.toMatchObject({
    scopes: [
      { environment: "node-sdk", health: "healthy" },
      { environment: "python-fixture", health: "healthy" },
    ],
    checkIns: expect.arrayContaining([
      expect.objectContaining({ environment: "node-sdk", status: "ok" }),
      expect.objectContaining({ environment: "python-fixture", status: "ok", durationMs: 250 }),
    ]),
  });
});

test("an owner links a reusable alert, mutes the monitor, and sees configuration and delivery history", async ({
  page,
  request,
}) => {
  const fixture = await newProject(request, "Monitor routing");
  const alert = `Cron email ${crypto.randomUUID().slice(0, 8)}`;

  await page.goto(`/${ORG}/monitors/alerts/new/`);
  await page.getByRole("textbox", { name: "Alert Name" }).fill(alert);
  await page.getByRole("button", { name: "Create Alert" }).click();
  await expect(page.getByRole("link", { name: alert })).toBeVisible();

  await page.goto(`/${ORG}/monitors/new/settings/?type=cron&project=${fixture.project.id}`);
  await page.getByRole("textbox", { name: "Monitor Name" }).fill("Muted cron");
  await page.getByLabel("Describe").fill("Monitors the nightly report");
  await page.getByLabel("Assign").selectOption({ label: "e2e@localhost" });
  await page.getByRole("button", { name: "Connect Existing Alerts" }).click();
  await page.getByRole("checkbox", { name: alert }).check();
  await page.getByRole("button", { name: "Create Monitor" }).click();

  await expect(page.getByRole("heading", { name: "Muted cron" })).toBeVisible();
  await expect(page.getByRole("cell", { name: alert })).toBeVisible();
  await page.getByRole("button", { name: "Mute", exact: true }).click();
  await page.getByRole("menuitem", { name: "Mute for 1 day" }).click();
  await expect(page.getByRole("button", { name: "Mute", exact: true })).toHaveText("Muted");

  await checkIn(request, fixture, { id: crypto.randomUUID(), slug: "muted-cron", status: "error" });
  const detail = await request.get(`/api/0/organizations${new URL(page.url()).pathname}`);

  await page.reload();
  await page.getByText("Alert deliveries (1)").click();
  await expect(page.getByText(/failure · email · not sent: muted/)).toBeVisible();
  await expect(detail.json()).resolves.toMatchObject({
    monitor: {
      health: "failing",
      description: "Monitors the nightly report",
      ownerId: expect.any(Number),
    },
    deliveries: [{ channel: "email", transition: "failure", suppression: "muted" }],
    audit: [{ version: 2, actorId: expect.any(Number) }, { version: 1 }],
  });
});

test("observation pagination returns an older page without duplicates", async ({ request }) => {
  const { project } = await newProject(request, "Paged history");

  const created = await request.post(MONITORS, {
    data: {
      projectId: project.id,
      type: "metric",
      name: "History",
      config: { windowSeconds: 300, threshold: 100 },
    },
  });

  expect(created.status(), await created.text()).toBe(201);
  const { id } = await contractJson<ApiMonitor>(created);
  const start = Date.now() + 8 * 60_000;

  for (let offset = 0; offset < 52; offset += 1) {
    await tick(request, start + offset * 60_000);
  }

  const first = await request.get(`${MONITORS}${id}/observations/`);
  const firstPage = await contractJson<MonitorHistory>(first);

  expect(firstPage.observations).toHaveLength(50);
  expect(firstPage.nextCursor).toEqual(expect.any(String));

  const next = await request.get(`${MONITORS}${id}/observations/`, {
    params: { cursor: firstPage.nextCursor ?? "" },
  });

  const secondPage = await contractJson<MonitorHistory>(next);

  expect(secondPage.observations).toHaveLength(2);
  expect(secondPage.nextCursor).toBeNull();
  expect(
    new Set(
      [...firstPage.observations, ...secondPage.observations].map(
        ({ id: observationId }: { id: number }) => observationId,
      ),
    ).size,
  ).toBe(52);
});

test("uptime previews use the private queue and leave live monitor state untouched", async ({
  request,
}) => {
  const { project } = await newProject(request, "Queued preview");
  const base = `/api/0/organizations/${ORG}/monitor-previews/`;

  const draft = {
    projectId: project.id,
    name: "Preview only",
    type: "uptime",
    config: {
      url: `${SHOP_URL}/monitor-health/${crypto.randomUUID()}`,
      method: "HEAD",
      intervalMinutes: 1,
      successCodes: [503],
    },
  };

  const started = await request.post(base, { data: draft });

  expect(started.status(), await started.text()).toBe(202);
  const job = await contractJson<MonitorPreviewJob>(started);
  expect(job).toMatchObject({ status: "pending", expiresAt: expect.any(Number) });

  await expect
    .poll(async () => {
      const response = await request.get(`${base}${job.id}/`);

      return response.json();
    })
    .toMatchObject({ status: "complete", result: { outcome: "ok", httpStatus: 503 } });

  const rejected = await request.post(base, {
    data: { ...draft, config: { ...draft.config, url: `${SHOP_URL}/?credential=secret` } },
  });

  expect(rejected.status()).toBe(400);
  const list = await request.get(MONITORS, { params: { project: project.id } });
  await expect(list.json()).resolves.toEqual([]);
});

test("withMonitor creates its monitor from monitor_config and an unknown slug is listed", async ({
  request,
}) => {
  const fixture = await newProject(request, "SDK-created cron");

  const client = Sentry.init({
    dsn: fixture.key.dsn,
    environment: "production",
    defaultIntegrations: false,
  });

  if (client === undefined) {
    throw new Error("Sentry Node SDK did not initialize");
  }

  await Sentry.withMonitor("Report Builder", async () => {}, {
    schedule: { type: "crontab", value: "*/5 * * * *" },
    checkinMargin: 2,
    maxRuntime: 10,
    timezone: "UTC",
  });
  Sentry.captureCheckIn({ monitorSlug: "never-configured", status: "ok" });
  expect(await client.close(5000)).toBe(true);

  const list = await request.get(MONITORS, { params: { project: fixture.project.id } });

  await expect(list.json()).resolves.toMatchObject([
    {
      type: "cron",
      name: "report-builder",
      health: "healthy",
      config: {
        slug: "report-builder",
        schedule: { type: "crontab", crontab: "*/5 * * * *" },
        graceMinutes: 2,
        maxRuntimeMinutes: 10,
      },
    },
  ]);

  const unrecognized = await request.get(`${MONITORS}unrecognized-check-ins/`);

  await expect(unrecognized.json()).resolves.toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        projectId: fixture.project.id,
        slug: "never-configured",
        reason: "unknown_slug",
      }),
    ]),
  );
});

test("the cron preview returns upcoming occurrences for a timezone-aware crontab", async ({
  request,
}) => {
  const { project } = await newProject(request, "DST cron");

  const response = await request.post(`/api/0/organizations/${ORG}/monitor-previews/`, {
    data: {
      projectId: project.id,
      type: "cron",
      name: "Local clock",
      config: {
        slug: "local-clock",
        schedule: { type: "crontab", crontab: "30 2 * * *" },
        timezone: "America/New_York",
      },
    },
  });

  expect(response.status(), await response.text()).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    type: "cron",
    occurrences: expect.arrayContaining([expect.any(Number)]),
  });
});

test("uptime preview records redirects and enforces the configured timeout", async ({
  request,
}) => {
  const { project } = await newProject(request, "Probe diagnostics");
  const path = `/api/0/organizations/${ORG}/monitor-previews/`;

  for (const [fixture, reason] of [
    ["redirect", "status"],
    ["timeout", "timeout"],
  ]) {
    const response = await request.post(path, {
      data: {
        projectId: project.id,
        name: "Probe diagnostics",
        type: "uptime",
        config: { url: `${SHOP_URL}/monitor-${fixture}`, intervalMinutes: 1, timeoutMs: 1000 },
      },
    });

    expect(response.status(), await response.text()).toBe(202);
    const { id } = await contractJson<MonitorPreviewJob>(response);

    await expect
      .poll(async () => {
        const result = await request.get(`${path}${id}/`);

        return result.json();
      })
      .toMatchObject({ status: "complete", result: { outcome: "failed", reason } });
  }
});
