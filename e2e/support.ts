// Helpers shared by the end-to-end tests: set up a project through the API,
// drive the fixture shop, and wait for what the SDK sent to be processed.

import type {
  ApiActivity,
  ApiEventDetail,
  ApiEventList,
  ApiIssue,
  ApiIssueList,
  ApiKey,
  ApiProject,
  ApiTag,
  StoredEvent,
} from "@contract";
import { expect } from "@playwright/test";
import type { APIRequestContext, Page, Response } from "@playwright/test";

import { ORG, SHOP_URL } from "./urls";

export type Fixture = { project: ApiProject; key: ApiKey };

export type ShopOptions = { release?: string; environment?: string; dsn?: string };

async function getJson<T>(request: APIRequestContext, path: string): Promise<T> {
  const response = await request.get(`/api/0${path}`);

  expect(response.status(), `GET ${path}`).toBe(200);

  // SAFETY: the Worker builds every response from the shared contract types.
  return (await response.json()) as T;
}

/** A new project with its first DSN. Every test gets its own, so tests can run in parallel. */
export async function newProject(request: APIRequestContext, name: string): Promise<Fixture> {
  const unique = `${name} ${crypto.randomUUID().slice(0, 8)}`;

  const created = await request.post(`/api/0/organizations/${ORG}/projects/`, {
    data: { name: unique, platform: "javascript" },
  });

  expect(created.status(), "create project").toBe(201);

  // SAFETY: the Worker builds every response from the shared contract types.
  const project = (await created.json()) as ApiProject;
  const [key] = await getJson<ApiKey[]>(request, `/projects/${ORG}/${project.slug}/keys/`);

  if (key === undefined) {
    throw new Error("a new project should come with a key");
  }

  return { project, key };
}

/** Opens the fixture shop with its SDK pointed at the project's DSN. */
export async function openShop(
  page: Page,
  fixture: Fixture,
  options: ShopOptions = {},
): Promise<void> {
  const query = new URLSearchParams({ dsn: options.dsn ?? fixture.key.dsn });

  if (options.release !== undefined) {
    query.set("release", options.release);
  }

  if (options.environment !== undefined) {
    query.set("environment", options.environment);
  }

  await page.goto(`${SHOP_URL}/?${query.toString()}`);
  await expect(page.locator("#status")).toHaveText("ready");
}

/** Clicks a shop button and returns Zentry's response to the envelope the SDK sends. */
export async function clickAndSend(page: Page, button: string): Promise<Response> {
  const sent = page.waitForResponse(
    (response) => response.url().includes("/envelope/") && response.request().method() === "POST",
  );

  await page.click(`#${button}`);

  return sent;
}

/** The project's issues in every status, unless `filter` (a query string) narrows them. */
export async function listIssues(
  request: APIRequestContext,
  fixture: Fixture,
  filter = "",
): Promise<ApiIssue[]> {
  const query = new URLSearchParams({ project: String(fixture.project.id), status: "all" });

  for (const [name, value] of new URLSearchParams(filter)) {
    query.set(name, value);
  }

  const path = `/organizations/${ORG}/issues/?${query.toString()}`;

  return (await getJson<ApiIssueList>(request, path)).issues;
}

/** Waits until the project has exactly `count` issues that have seen `events` events in total. */
export async function waitForIssues(
  request: APIRequestContext,
  fixture: Fixture,
  expected: { issues: number; events: number },
): Promise<ApiIssue[]> {
  await expect
    .poll(
      async () => {
        const issues = await listIssues(request, fixture);

        return {
          issues: issues.length,
          events: issues.reduce((sum, issue) => sum + issue.timesSeen, 0),
        };
      },
      { message: "issues processed by the consumer", intervals: [500] },
    )
    .toEqual(expected);

  return listIssues(request, fixture);
}

/** Waits for exactly one issue with `events` events and returns it. */
export async function waitForIssue(
  request: APIRequestContext,
  fixture: Fixture,
  events = 1,
): Promise<ApiIssue> {
  const [issue] = await waitForIssues(request, fixture, { issues: 1, events });

  if (issue === undefined) {
    throw new Error("expected one issue");
  }

  return issue;
}

export function getIssue(request: APIRequestContext, issueId: number): Promise<ApiIssue> {
  return getJson(request, `/organizations/${ORG}/issues/${issueId}/`);
}

export async function latestEvent(
  request: APIRequestContext,
  issue: ApiIssue,
): Promise<StoredEvent> {
  const path = `/organizations/${ORG}/issues/${issue.id}/events/latest/`;

  return (await getJson<ApiEventDetail>(request, path)).event;
}

export function listEvents(request: APIRequestContext, issue: ApiIssue): Promise<ApiEventList> {
  return getJson(request, `/organizations/${ORG}/issues/${issue.id}/events/`);
}

export function listTags(request: APIRequestContext, issue: ApiIssue): Promise<ApiTag[]> {
  return getJson(request, `/organizations/${ORG}/issues/${issue.id}/tags/`);
}

export function listActivity(request: APIRequestContext, issue: ApiIssue): Promise<ApiActivity[]> {
  return getJson(request, `/organizations/${ORG}/issues/${issue.id}/activity/`);
}

/** The values of one tag on an event, e.g. `tagOf(event, "environment")`. */
export function tagOf(event: StoredEvent, key: string): string | undefined {
  return event.tags.find(([name]) => name === key)?.[1];
}
