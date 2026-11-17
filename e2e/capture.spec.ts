// What the SDK captures in the browser arrives intact: the error, where it
// happened, and the context around it.

import { expect, test } from "@playwright/test";

import {
  clickAndSend,
  latestEvent,
  listIssues,
  listTags,
  newProject,
  openShop,
  tagOf,
  waitForIssue,
} from "./support";
import { SHOP_URL } from "./urls";

test("an uncaught error becomes an issue with its stack trace", async ({ page, request }) => {
  const fixture = await newProject(request, "Uncaught");

  await openShop(page, fixture);

  const response = await clickAndSend(page, "apply-discount");

  expect(response.status()).toBe(200);

  const issue = await waitForIssue(request, fixture);

  expect(issue.title).toBe("TypeError: Discount code SPRING-20 is not valid for this basket");
  expect(issue.metadata.type).toBe("TypeError");
  expect(issue.level).toBe("error");
  expect(issue.status).toBe("unresolved");
  expect(issue.platform).toBe("javascript");
  expect(issue.shortId).toMatch(/-1$/);
  expect(issue.culprit).toContain("applyDiscount");

  const event = await latestEvent(request, issue);
  const [exception] = event.exceptions;

  expect(event.eventId).toBe(issue.lastEventId);
  expect(exception?.type).toBe("TypeError");
  expect(exception?.mechanism?.handled).toBe(false);

  // The innermost frame is the function that threw, in the shop's own source.
  const thrower = exception?.frames.at(-1);

  expect(thrower?.function).toBe("applyDiscount");
  expect(thrower?.filename).toContain("main.ts");
  expect(thrower?.lineno).toBeGreaterThan(0);
  expect(thrower?.inApp).toBe(true);
});

test("the event carries release, environment, browser and page", async ({ page, request }) => {
  const fixture = await newProject(request, "Context");

  await openShop(page, fixture, { release: "shop@2.4.1", environment: "staging" });
  await page.click("#apply-discount");

  const issue = await waitForIssue(request, fixture);
  const event = await latestEvent(request, issue);
  const tags = await listTags(request, issue);

  const valueOf = (key: string): string | undefined =>
    tags.find((tag) => tag.key === key)?.values[0]?.value;

  expect(event.release).toBe("shop@2.4.1");
  expect(event.environment).toBe("staging");
  // Zentry derives these tags itself; the shop never set them.
  expect(valueOf("release")).toBe("shop@2.4.1");
  expect(valueOf("environment")).toBe("staging");
  expect(valueOf("browser.name")).toBe("Chrome");
  expect(valueOf("handled")).toBe("no");
  expect(valueOf("level")).toBe("error");
  expect(event.request?.url).toContain(SHOP_URL);
  expect(event.sdk?.name).toBe("sentry.javascript.browser");
  expect(event.platform).toBe("javascript");
  expect(Math.abs(event.receivedAt - Date.now())).toBeLessThan(120_000);
});

test("an unhandled promise rejection is captured as unhandled", async ({ page, request }) => {
  const fixture = await newProject(request, "Rejection");

  await openShop(page, fixture);
  await page.click("#pay");

  const issue = await waitForIssue(request, fixture);
  const event = await latestEvent(request, issue);

  expect(issue.title).toBe("Error: Payment gateway timed out");
  expect(event.exceptions[0]?.mechanism?.handled).toBe(false);
  expect(event.exceptions[0]?.mechanism?.type).toContain("unhandledrejection");
  expect(event.exceptions[0]?.frames.at(-1)?.function).toBe("chargeCard");
});

test("a handled error keeps its user, tags and breadcrumbs", async ({ page, request }) => {
  const fixture = await newProject(request, "Handled");

  await openShop(page, fixture);
  await page.click("#save-profile");

  const issue = await waitForIssue(request, fixture);
  const event = await latestEvent(request, issue);

  expect(issue.title).toBe("RangeError: Profile photo exceeds the upload limit");
  expect(event.exceptions[0]?.mechanism?.handled).toBe(true);
  expect(event.user).toMatchObject({ id: "u-481", email: "ada@example.com", username: "ada" });
  expect(tagOf(event, "feature")).toBe("profile");
  expect(tagOf(event, "plan")).toBe("pro");

  const messages = event.breadcrumbs.map((crumb) => crumb.message);
  const categories = event.breadcrumbs.map((crumb) => crumb.category);

  expect(messages).toEqual(expect.arrayContaining(["Opened profile form", "Validation passed"]));
  // The SDK records the click that led to the error on its own.
  expect(categories).toContain("ui.click");
});

test("secrets in extra data are scrubbed before storage", async ({ page, request }) => {
  const fixture = await newProject(request, "Scrubbing");

  await openShop(page, fixture);
  await page.click("#save-profile");

  const event = await latestEvent(request, await waitForIssue(request, fixture));

  expect(event.extra).toMatchObject({
    attempt: 3,
    note: "kept as is",
    password: "[Filtered]",
    apiToken: "[Filtered]",
    cardNumber: "[Filtered]",
  });
  expect(JSON.stringify(event)).not.toContain("hunter2");
  expect(JSON.stringify(event)).not.toContain("4111 1111 1111 1111");
});

test("a captured message becomes an issue at its own level", async ({ page, request }) => {
  const fixture = await newProject(request, "Message");

  await openShop(page, fixture);
  await page.click("#check-stock");

  const issue = await waitForIssue(request, fixture);
  const event = await latestEvent(request, issue);

  expect(issue.title).toBe("Stock level is low for the featured product");
  expect(issue.level).toBe("warning");
  // The browser SDK attaches a synthetic stack trace to messages. It must not
  // turn the message into an "Error: …" issue.
  expect(event.exceptions.every((exception) => exception.mechanism?.synthetic)).toBe(true);
  expect(issue.metadata.type).toBeNull();

  // The level filter on the issue list finds it, and only under its own level.
  expect(await listIssues(request, fixture, "&level=warning")).toHaveLength(1);
  expect(await listIssues(request, fixture, "&level=error")).toHaveLength(0);
});

test("an error with a cause stores the whole chain", async ({ page, request }) => {
  const fixture = await newProject(request, "Cause");

  await openShop(page, fixture);
  await page.click("#checkout");

  const issue = await waitForIssue(request, fixture);
  const event = await latestEvent(request, issue);

  // The issue is named after the outer error; the cause is kept beneath it.
  expect(issue.title).toBe("Error: Checkout could not be completed");
  expect(event.exceptions.map((exception) => exception.value)).toEqual([
    "Card was declined by the issuer",
    "Checkout could not be completed",
  ]);
  expect(event.exceptions.every((exception) => exception.frames.length > 0)).toBe(true);
});

test("throwing something that is not an Error still produces an issue", async ({
  page,
  request,
}) => {
  const fixture = await newProject(request, "Text");

  await openShop(page, fixture);
  await page.click("#throw-text");

  const issue = await waitForIssue(request, fixture);

  expect(issue.title).toContain("legacy widget exploded");
  expect(issue.level).toBe("error");
});
