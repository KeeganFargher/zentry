import { unlink, writeFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";
import type { APIRequestContext } from "@playwright/test";

import { clickAndSend, newProject, openShop, waitForIssues } from "./support";
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

test("a scheduled metric evaluation counts matching SDK errors", async ({ page, request }) => {
  const fixture = await newProject(request, "Monitor counts");

  const created = await request.post(MONITORS, {
    data: {
      projectId: fixture.project.id,
      name: "Production errors",
      type: "metric",
      config: { windowSeconds: 300, threshold: 1, environment: "production" },
    },
  });

  expect(created.status()).toBe(201);

  await openShop(page, fixture, { environment: "production" });
  expect((await clickAndSend(page, "apply-discount")).ok()).toBe(true);
  await waitForIssues(request, fixture, { issues: 1, events: 1 });

  const scheduled = await request.get("/cdn-cgi/local/scheduled", {
    params: { cron: "* * * * *", time: Date.now() + 180_000, format: "json" },
  });

  expect(scheduled.ok()).toBe(true);

  const list = await request.get(MONITORS, { params: { project: fixture.project.id } });
  await expect(list.json()).resolves.toMatchObject([{ health: "failing" }]);
});

test("an SDK check-in changes the health of its configured cron monitor", async ({ request }) => {
  const fixture = await newProject(request, "Cron check-ins");

  const created = await request.post(MONITORS, {
    data: {
      projectId: fixture.project.id,
      name: "Nightly import",
      type: "cron",
      config: { slug: "nightly", environment: "production", intervalMinutes: 1440 },
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

  await page.getByRole("button", { name: "Pause monitor" }).click();
  await expect(page.getByRole("button", { name: "Resume monitor" })).toBeVisible();
  await page.getByRole("button", { name: "Resume monitor" }).click();
  await expect(page.getByRole("button", { name: "Pause monitor" })).toBeVisible();
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
  },
): Promise<void> {
  const items = [
    { dsn: fixture.key.dsn },
    { type: "check_in" },
    {
      check_in_id: data.id,
      monitor_slug: data.slug,
      status: data.status,
      environment: "production",
    },
  ];

  const response = await request.post(`/api/${fixture.project.id}/envelope/`, {
    data: items.map((item) => JSON.stringify(item)).join("\n"),
  });

  expect(response.ok(), await response.text()).toBe(true);
}

test("cron deduplicates check-ins and resolves the same incident on success", async ({
  request,
}) => {
  const fixture = await newProject(request, "Cron recovery");

  const created = await request.post(MONITORS, {
    data: {
      projectId: fixture.project.id,
      name: "Export",
      type: "cron",
      config: {
        slug: "export",
        environment: "production",
        expression: "0 5 * * *",
        timezone: "Africa/Johannesburg",
      },
    },
  });

  expect(created.status(), await created.text()).toBe(201);

  const run = { id: crypto.randomUUID(), slug: "export" };
  await checkIn(request, fixture, { ...run, status: "in_progress" });
  await checkIn(request, fixture, { ...run, status: "error" });
  await checkIn(request, fixture, { ...run, status: "error" });
  const [open] = await waitForIssues(request, fixture, { issues: 1, events: 1 });

  expect(open).toMatchObject({ status: "unresolved", title: "Export" });

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
          environment: "production",
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
