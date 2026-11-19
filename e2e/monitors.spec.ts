import { unlink, writeFile } from "node:fs/promises";
import { setTimeout as wait } from "node:timers/promises";

import type { ApiMonitor, MonitorHistory, MonitorPreviewJob, MonitorDetail } from "@contract";
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
  test.setTimeout(90_000);
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
  const firstCoveredMinute = Math.ceil(Date.now() / 60_000) * 60_000;
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
      config: { slug: "nightly", environments: ["production"], intervalMinutes: 1440 },
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
    config: { url: "http://localhost:5199/", intervalMinutes: 1 },
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

test("the Monitors page creates and pauses a metric monitor", async ({ page, request }) => {
  const { project } = await newProject(request, "Monitor UI");

  await page.goto(`/${ORG}/monitors/`);
  await page
    .getByRole("combobox", { name: "Project", exact: true })
    .selectOption(String(project.id));
  await page.getByLabel("Monitor name").fill("Checkout error count");
  await page.getByLabel("Error count threshold").fill("4");
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(page.getByText(/Processed errors in the window/)).toBeVisible();
  await page.getByRole("button", { name: "Create monitor" }).click();

  await expect(page.getByRole("heading", { name: "Checkout error count" })).toBeVisible();

  await page.getByRole("button", { name: "Edit monitor" }).click();
  await page.getByLabel("Monitor name").fill("Checkout production errors");
  await page.getByLabel("Error count threshold").fill("9");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByRole("heading", { name: "Checkout production errors" })).toBeVisible();
  await expect(page.getByText(/Open an issue at 9 errors/)).toBeVisible();

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
  await page.getByRole("button", { name: "Pause monitor" }).click();
  await expect(page.getByRole("button", { name: "Resume monitor" })).toBeVisible();
  await page.getByRole("button", { name: "Resume monitor" }).click();
  await expect(page.getByRole("button", { name: "Pause monitor" })).toBeVisible();
  await page.getByRole("link", { name: "All monitors" }).click();
  await page.getByText("Monitoring operations", { exact: true }).click();
  await expect(page.getByText("Last recorded evaluation", { exact: true })).toBeVisible();
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

test("cron deduplicates check-ins and only recovers at an eligible slot", async ({ request }) => {
  const fixture = await newProject(request, "Cron recovery");

  const created = await request.post(MONITORS, {
    data: {
      projectId: fixture.project.id,
      name: "Export",
      type: "cron",
      config: {
        slug: "export",
        environments: ["production"],
        intervalMinutes: 1,
      },
    },
  });

  expect(created.status(), await created.text()).toBe(201);

  const started = Date.now();
  const run = { id: crypto.randomUUID(), slug: "export" };
  await checkIn(request, fixture, { ...run, status: "in_progress" });
  await checkIn(request, fixture, { ...run, status: "error" });
  await checkIn(request, fixture, { ...run, status: "error" });
  const [open] = await waitForIssues(request, fixture, { issues: 1, events: 1 });

  expect(open).toMatchObject({ status: "unresolved", title: "Export" });

  await checkIn(request, fixture, { ...run, id: crypto.randomUUID(), status: "ok" });

  const [stillOpen] = await waitForIssues(request, fixture, { issues: 1, events: 1 });
  expect(stillOpen?.status).toBe("unresolved");

  await wait(Math.max(0, started + 30_500 - Date.now()));
  await checkIn(request, fixture, { ...run, id: crypto.randomUUID(), status: "ok" });

  const [resolved] = await waitForIssues(request, fixture, { issues: 1, events: 1 });
  expect(resolved).toMatchObject({ id: open?.id, status: "resolved" });
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
          environments: ["production"],
          intervalMinutes: slug === "missing" ? 1 : 60,
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

test("cron tracks environments separately and rejects a completion past its runtime", async ({
  request,
}) => {
  const fixture = await newProject(request, "Scoped cron");

  const response = await request.post(MONITORS, {
    data: {
      projectId: fixture.project.id,
      name: "Scoped export",
      type: "cron",
      config: {
        slug: "scoped-export",
        environments: ["production", "staging"],
        intervalMinutes: 30,
        maxRuntimeMinutes: 1,
      },
    },
  });

  expect(response.status(), await response.text()).toBe(201);
  const { id } = await contractJson<ApiMonitor>(response);
  const run = { id: crypto.randomUUID(), slug: "scoped-export" };
  await checkIn(request, fixture, { ...run, status: "in_progress" });
  await checkIn(request, fixture, { ...run, status: "ok", duration: 61 });
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
    observations: expect.arrayContaining([
      expect.objectContaining({
        scope: "production",
        evidence: expect.objectContaining({
          outcome: "timed_out",
          runId: run.id.replaceAll("-", ""),
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

test("real JavaScript and captured Python SDK envelopes arm the configured cron scopes", async ({
  request,
}) => {
  const fixture = await newProject(request, "Stock SDK check-ins");

  const monitor = await request.post(MONITORS, {
    data: {
      projectId: fixture.project.id,
      type: "cron",
      name: "Stock SDK",
      config: {
        slug: "stock-sdk",
        environments: ["node-sdk", "python-fixture"],
        intervalMinutes: 60,
      },
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

test("an owner links a reusable rule, mutes alerts, and sees configuration and delivery history", async ({
  page,
  request,
}) => {
  const fixture = await newProject(request, "Monitor routing");

  await page.goto(`/${ORG}/monitors/`);
  await page.getByText("Manage alert rules", { exact: true }).click();
  await page.getByLabel("Rule name").fill("Cron email rule");
  await page.getByRole("button", { name: "Create alert rule" }).click();
  await expect(page.getByRole("button", { name: "Save alert rule" })).toBeVisible();
  await page
    .getByRole("combobox", { name: "Project", exact: true })
    .selectOption(String(fixture.project.id));
  await page.getByLabel("Monitor type").selectOption("cron");
  await page.getByLabel("Monitor name").fill("Muted cron");
  await page.getByLabel("SDK monitor slug").fill("muted-cron");
  await page.getByLabel("Description").fill("Monitors the nightly report");
  await page.getByLabel("Monitor owner", { exact: true }).selectOption({ label: "e2e@localhost" });
  await page.getByLabel("Linked alert rules").selectOption({ label: "Cron email rule" });
  await page.getByRole("button", { name: "Create monitor" }).click();

  await expect(page.getByRole("heading", { name: "Muted cron" })).toBeVisible();
  await page.getByRole("button", { name: "Mute alerts" }).click();
  await expect(page.getByText(/Muted until/)).toBeVisible();

  await checkIn(request, fixture, { id: crypto.randomUUID(), slug: "muted-cron", status: "error" });
  const detail = await request.get(`/api/0/organizations${new URL(page.url()).pathname}`);

  await page.reload();
  await expect(page.getByRole("heading", { name: "Alert deliveries" })).toBeVisible();
  await expect(page.getByText(/failure · email · muted/)).toBeVisible();
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

test("a later cron success waits for an overlapping run and closes its incident in chronological order", async ({
  request,
}) => {
  test.setTimeout(45_000);
  const fixture = await newProject(request, "Overlapping runs");
  const slug = "periodic";

  const created = await request.post(MONITORS, {
    data: {
      projectId: fixture.project.id,
      type: "cron",
      name: "Periodic",
      config: { slug, intervalMinutes: 1, maxRuntimeMinutes: 1, environments: ["production"] },
    },
  });

  expect(created.status(), await created.text()).toBe(201);
  const { id } = await contractJson<ApiMonitor>(created);
  const started = Date.now();

  await checkIn(request, fixture, { id: crypto.randomUUID(), slug, status: "in_progress" });
  await wait(Math.max(0, started + 30_500 - Date.now()));
  await checkIn(request, fixture, { id: crypto.randomUUID(), slug, status: "ok" });

  const path = `${MONITORS}${id}/`;
  const before = await request.get(path);
  await expect(before.json()).resolves.toMatchObject({ observations: [], incidents: [] });
  await tick(request, started + 65_000);
  const result = await contractJson<MonitorDetail>(await request.get(path));
  expect(result.observations.map(({ health }) => health)).toEqual(["healthy", "failing"]);
  const period = result.incidents[0];

  expect(period).toBeDefined();
  expect(period?.closedAt).toBeGreaterThan(period?.openedAt ?? 0);
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
        environments: ["production"],
        expression: "30 2 * * *",
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
