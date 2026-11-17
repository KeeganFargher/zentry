// The whole loop as a person sees it: an error happens in the shop, shows up
// in Zentry's own UI, and is triaged there.

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import {
  getIssue,
  listActivity,
  listIssues,
  newProject,
  openShop,
  waitForIssue,
  waitForIssues,
} from "./support";
import type { Fixture } from "./support";
import { ORG } from "./urls";

async function breakDiscount(page: Page, fixture: Fixture): Promise<void> {
  // A fresh page load each time: the SDK drops an error identical to the one before it.
  await openShop(page, fixture);
  await page.click("#apply-discount");
}

test("an error from the shop can be found and read in the UI", async ({ page, request }) => {
  const fixture = await newProject(request, "Read in UI");

  await breakDiscount(page, fixture);

  const issue = await waitForIssue(request, fixture);

  await page.goto(`/${ORG}/issues/?project=${fixture.project.id}`);
  await expect(page.getByText(issue.shortId)).toBeVisible();
  await expect(
    page.getByText("Discount code SPRING-20 is not valid for this basket"),
  ).toBeVisible();

  await page.getByRole("link", { name: "TypeError" }).click();
  await expect(page).toHaveURL(new RegExp(`/issues/${issue.id}/$`));
  await expect(page.getByRole("heading", { name: "TypeError" })).toBeVisible();

  // The stack trace names the function that threw, and marks it as the shop's code.
  const trace = page.locator("#stack-trace");

  await expect(trace.getByText("applyDiscount").first()).toBeVisible();
  await expect(trace.getByText("In App").first()).toBeVisible();
  await expect(trace.getByText("handled: false")).toBeVisible();

  // The click that caused it is in the breadcrumbs, and the release is in the header.
  await expect(page.locator("#breadcrumbs").getByText("ui.click")).toBeVisible();
  await expect(page.locator(".event-meta").getByText("shop@1.0.0")).toBeVisible();
  await expect(page.locator(".event-meta").getByText("e2e")).toBeVisible();
});

test("a resolved issue that happens again is reopened as regressed", async ({ page, request }) => {
  const fixture = await newProject(request, "Regression");

  await breakDiscount(page, fixture);

  const issue = await waitForIssue(request, fixture);

  await page.goto(`/${ORG}/issues/${issue.id}/`);
  await page.getByRole("button", { name: "Resolve", exact: true }).click();
  await expect(page.getByRole("button", { name: "Unresolve" })).toBeVisible();
  expect((await getIssue(request, issue.id)).status).toBe("resolved");

  // Resolved issues leave the default feed.
  expect(await listIssues(request, fixture, "&status=unresolved")).toHaveLength(0);

  await breakDiscount(page, fixture);

  const reopened = await waitForIssue(request, fixture, 2);
  const activity = (await listActivity(request, reopened)).map((entry) => entry.type);

  expect(reopened.id).toBe(issue.id);
  expect(reopened.status).toBe("unresolved");
  expect(reopened.substatus).toBe("regressed");
  expect(activity).toEqual(expect.arrayContaining(["resolved", "regressed"]));

  await page.goto(`/${ORG}/issues/${issue.id}/`);
  await expect(page.locator(".substatus")).toHaveText("Regressed");
  await expect(page.getByRole("button", { name: "Resolve", exact: true })).toBeVisible();
});

test("an archived issue stays archived when it happens again", async ({ page, request }) => {
  const fixture = await newProject(request, "Archived");

  await breakDiscount(page, fixture);

  const issue = await waitForIssue(request, fixture);

  await page.goto(`/${ORG}/issues/${issue.id}/`);
  await page.getByRole("button", { name: "Archive" }).click();
  await expect(page.locator(".substatus")).toHaveText("Archived");

  await breakDiscount(page, fixture);

  const again = await waitForIssue(request, fixture, 2);

  expect(again.status).toBe("ignored");
  expect(again.substatus).toBeNull();
});

test("several issues can be resolved at once from the list", async ({ page, request }) => {
  const fixture = await newProject(request, "Bulk");

  await openShop(page, fixture);
  await page.click("#apply-discount");
  await page.click("#checkout");
  await waitForIssues(request, fixture, { issues: 2, events: 2 });

  await page.goto(`/${ORG}/issues/?project=${fixture.project.id}`);
  await expect(page.locator(".issue-row:not(.head)")).toHaveCount(2);
  await page.getByLabel("Select all").check();
  await page.getByRole("button", { name: "Resolve", exact: true }).click();

  // A whole page of issues is confirmed first, as on Sentry.
  const dialog = page.getByRole("dialog");

  await expect(dialog).toContainText("Resolve 2 issues?");
  await dialog.getByRole("button", { name: "Resolve" }).click();
  await expect(page.getByText("couldn't find any issues that matched your filters")).toBeVisible();
  await expect(page.getByText("Resolved 2 issues")).toBeVisible();

  const statuses = (await listIssues(request, fixture)).map((entry) => entry.status);

  expect(statuses).toEqual(["resolved", "resolved"]);
});

test("a deleted issue is gone, and the same error starts a new one", async ({ page, request }) => {
  const fixture = await newProject(request, "Delete");

  await breakDiscount(page, fixture);

  const issue = await waitForIssue(request, fixture);
  const eventUrl = `/api/0/organizations/${ORG}/issues/${issue.id}/events/${issue.lastEventId}/`;

  expect((await request.get(eventUrl)).status()).toBe(200);

  await page.goto(`/${ORG}/issues/${issue.id}/`);
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(page).toHaveURL(new RegExp(`/${ORG}/issues/$`));

  expect(await listIssues(request, fixture)).toHaveLength(0);
  expect((await request.get(eventUrl)).status()).toBe(404);

  await breakDiscount(page, fixture);

  const fresh = await waitForIssue(request, fixture);

  // A new issue with the next short id, counting from one again.
  expect(fresh.shortId).toMatch(/-2$/);
  expect(fresh.timesSeen).toBe(1);
  expect(fresh.firstSeen).toBeGreaterThan(issue.firstSeen);
});

test("the issue list can be searched and sorted", async ({ page, request }) => {
  const fixture = await newProject(request, "Search");

  await openShop(page, fixture);
  await page.click("#apply-discount");
  await page.click("#load-order");
  await page.click("#load-order");
  await waitForIssues(request, fixture, { issues: 2, events: 3 });

  const found = await listIssues(request, fixture, "&query=Discount");
  const byFrequency = await listIssues(request, fixture, "&sort=freq");

  expect(found.map((entry) => entry.metadata.type)).toEqual(["TypeError"]);
  expect(byFrequency.map((entry) => entry.timesSeen)).toEqual([2, 1]);

  await page.goto(`/${ORG}/issues/?project=${fixture.project.id}`);
  await page.getByLabel("Search issues").fill("Discount");
  await page.getByLabel("Search issues").press("Enter");
  await expect(page.locator(".issue-row:not(.head)")).toHaveCount(1);
  await expect(page.getByRole("link", { name: "TypeError" })).toBeVisible();
});

test("project settings show the DSN the shop reports to", async ({ page, request }) => {
  const fixture = await newProject(request, "Settings");

  await page.goto(`/${ORG}/settings/projects/${fixture.project.slug}/`);
  await expect(page.getByText(fixture.key.dsn).first()).toBeVisible();
  expect(fixture.key.dsn).toMatch(/^http:\/\/[0-9a-f]{32}@localhost:8798\/\d+$/);
});

test("the theme can be switched and the choice is remembered", async ({ page }) => {
  const theme = (): Promise<string | null> =>
    page.evaluate(() => document.documentElement.dataset["theme"] ?? null);

  // With no saved choice the UI follows the system setting.
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto(`/${ORG}/issues/`);
  expect(await theme()).toBe("dark");

  await page.getByRole("button", { name: "Switch to light mode" }).click();
  expect(await theme()).toBe("light");
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(255, 255, 255)");

  await page.reload();
  expect(await theme()).toBe("light");
  await expect(page.getByRole("button", { name: "Switch to dark mode" })).toBeVisible();
});

test("an issue is unread until it is opened", async ({ page, request }) => {
  const fixture = await newProject(request, "Unread");

  await breakDiscount(page, fixture);

  const issue = await waitForIssue(request, fixture);
  const row = page.locator(".issue-row:not(.head)");

  expect(issue.hasSeen).toBe(false);

  await page.goto(`/${ORG}/issues/?project=${fixture.project.id}`);
  await expect(row.locator(".unread-dot")).toBeVisible();
  await expect(row.locator(".issue-type")).toHaveCSS("font-weight", "600");

  // Opening the issue is what marks it as seen.
  await row.getByRole("link", { name: "TypeError" }).click();
  await expect(page.getByRole("heading", { name: "TypeError" })).toBeVisible();
  await expect.poll(async () => (await getIssue(request, issue.id)).hasSeen).toBe(true);

  await page.goto(`/${ORG}/issues/?project=${fixture.project.id}`);
  await expect(row).toHaveCount(1);
  await expect(row.locator(".unread-dot")).toHaveCount(0);
  await expect(row.locator(".issue-type")).toHaveCSS("font-weight", "400");
});

test("live updates bring in new issues without a reload", async ({ page, context, request }) => {
  const fixture = await newProject(request, "Live");
  const rows = page.locator(".issue-row:not(.head)");

  await page.goto(`/${ORG}/issues/?project=${fixture.project.id}`);
  await expect(page.getByText("Waiting for events")).toBeVisible();
  await page.getByRole("button", { name: "Enable real-time updates" }).click();
  await expect(page.getByRole("button", { name: "Pause real-time updates" })).toBeVisible();

  const shop = await context.newPage();

  await breakDiscount(shop, fixture);
  await waitForIssue(request, fixture);
  await expect(rows).toHaveCount(1, { timeout: 15_000 });

  // The choice is remembered for the next visit.
  await page.reload();
  await expect(page.getByRole("button", { name: "Pause real-time updates" })).toBeVisible();
});

test("a row opens its issue, and shift-click selects a range", async ({ page, request }) => {
  const fixture = await newProject(request, "Rows");

  await openShop(page, fixture);
  await page.click("#apply-discount");
  await page.click("#checkout");
  await waitForIssues(request, fixture, { issues: 2, events: 2 });

  await page.goto(`/${ORG}/issues/?project=${fixture.project.id}`);

  const rows = page.locator(".issue-row:not(.head)");

  await rows.nth(0).getByRole("checkbox").click();
  await rows
    .nth(1)
    .locator(".col-last")
    .click({ modifiers: ["Shift"] });
  await expect(page.getByText("2 selected")).toBeVisible();

  await rows.nth(0).getByRole("checkbox").click();
  await rows.nth(1).getByRole("checkbox").click();
  await expect(page.getByLabel("Select all")).not.toBeChecked();

  const title = await rows.nth(0).locator(".issue-type").innerText();

  await rows.nth(0).locator(".col-events").click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();
});
