// Events that are the same problem end up in one issue; different problems do not.

import { expect, test } from "@playwright/test";

import {
  latestEvent,
  listEvents,
  listIssues,
  listTags,
  newProject,
  openShop,
  waitForIssue,
  waitForIssues,
} from "./support";

test("messages that differ only by ids group into one issue", async ({ page, request }) => {
  const fixture = await newProject(request, "Parameterized");

  await openShop(page, fixture);

  for (let click = 0; click < 5; click += 1) {
    await page.click("#load-order");
  }

  const issue = await waitForIssue(request, fixture, 5);
  const { events } = await listEvents(request, issue);

  expect(issue.timesSeen).toBe(5);
  expect(events).toHaveLength(5);
  expect(new Set(events.map((event) => event.eventId)).size).toBe(5);
  expect(issue.lastSeen).toBeGreaterThanOrEqual(issue.firstSeen);
  // The hourly series on the issue list accounts for all five.
  expect(issue.stats.reduce((sum, [, count]) => sum + count, 0)).toBe(5);
});

test("different errors become different issues with their own short ids", async ({
  page,
  request,
}) => {
  const fixture = await newProject(request, "Distinct");

  await openShop(page, fixture);
  await page.click("#apply-discount");
  await page.click("#checkout");
  await page.click("#check-stock");

  const issues = await waitForIssues(request, fixture, { issues: 3, events: 3 });
  const numbers = issues.map((issue) => Number(issue.shortId.split("-").at(-1)));

  expect(numbers.toSorted((left, right) => left - right)).toEqual([1, 2, 3]);
  expect(new Set(issues.map((issue) => issue.title)).size).toBe(3);
});

test("a custom fingerprint merges errors with different messages", async ({ page, request }) => {
  const fixture = await newProject(request, "Fingerprint merge");

  await openShop(page, fixture);
  await page.click("#sync-eu");
  await page.click("#sync-us");

  const issue = await waitForIssue(request, fixture, 2);
  const region = (await listTags(request, issue)).find((tag) => tag.key === "region");

  expect((await latestEvent(request, issue)).fingerprint).toEqual(["inventory-sync"]);
  expect(region?.values.map((entry) => entry.value).toSorted()).toEqual(["eu-west", "us-east"]);
  expect(region?.values.every((entry) => entry.count === 1)).toBe(true);
});

test("a custom fingerprint splits one error into several issues", async ({ page, request }) => {
  const fixture = await newProject(request, "Fingerprint split");

  await openShop(page, fixture);
  await page.click("#search");
  await page.click("#search");

  const issues = await waitForIssues(request, fixture, { issues: 2, events: 2 });

  expect(issues.map((issue) => issue.title)).toEqual([
    "Error: Search index is unavailable",
    "Error: Search index is unavailable",
  ]);
});

test("one issue collects events from several environments and releases", async ({
  page,
  request,
}) => {
  const fixture = await newProject(request, "Environments");

  await openShop(page, fixture, { environment: "production", release: "shop@1.0.0" });
  await page.click("#apply-discount");
  await openShop(page, fixture, { environment: "staging", release: "shop@1.1.0" });
  await page.click("#apply-discount");

  const issue = await waitForIssue(request, fixture, 2);
  const tags = await listTags(request, issue);

  const valuesOf = (key: string): string[] =>
    (tags.find((tag) => tag.key === key)?.values ?? []).map((entry) => entry.value).toSorted();

  expect(valuesOf("environment")).toEqual(["production", "staging"]);
  expect(valuesOf("release")).toEqual(["shop@1.0.0", "shop@1.1.0"]);
  expect(issue.firstRelease).toBe("shop@1.0.0");

  // The tag filter on the issue list matches either environment and nothing else.
  expect(await listIssues(request, fixture, "&tag=environment:staging")).toHaveLength(1);
  expect(await listIssues(request, fixture, "&tag=environment:qa")).toHaveLength(0);
});

test("projects are isolated from each other", async ({ page, request }) => {
  const first = await newProject(request, "Isolation A");
  const second = await newProject(request, "Isolation B");

  await openShop(page, first);
  await page.click("#apply-discount");
  await waitForIssue(request, first);

  expect(await listIssues(request, second)).toHaveLength(0);

  await openShop(page, second);
  await page.click("#apply-discount");

  const issue = await waitForIssue(request, second);

  // Same error, but each project numbers its own issues from one.
  expect(issue.shortId).toMatch(/-1$/);
  expect(issue.projectId).toBe(second.project.id);
  expect(await listIssues(request, first)).toHaveLength(1);
});
