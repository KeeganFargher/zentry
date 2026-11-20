import { describe, expect, it } from "vitest";

import {
  alertPush,
  compactCount,
  digestPush,
  quotaPush,
  spikePush,
  summaryDigestPush,
  summaryPush,
  workflowPush,
} from "@/core/push-messages";
import type { IssueNotice } from "@/shared/notify";

const SUMMARY = {
  headline: "Discord rate limit blocking price alerts",
  detail: "Discord is rate limiting the webhook, so price alerts likely failed to send.",
};

const NOW = Date.UTC(2026, 10, 17, 10, 30);

const project = {
  id: 3,
  slug: "api",
  name: "API",
  organization: { id: 1, slug: "acme", name: "Acme" },
};

function issue(id: number, title: string): IssueNotice {
  return {
    id,
    shortId: `API-${id}`,
    title,
    culprit: "app/views.py in checkout",
    level: "error",
    message: null,
    status: "unresolved",
    timesSeen: 3,
    firstSeen: NOW,
    lastSeen: NOW,
    lastEventId: null,
    project,
  };
}

describe("push messages", () => {
  it("says what happened and where, and opens the issue", () => {
    const push = alertPush(issue(12, "TypeError: x is undefined"), "regression");

    expect(push).toEqual({
      channel: "alerts",
      title: "Regression in api · API-12",
      body: "TypeError: x is undefined\napp/views.py in checkout",
      data: { kind: "issue", organization: "acme", issueId: 12 },
    });
  });

  it("keeps a long title short enough for a lock screen", () => {
    const push = alertPush(issue(1, "E".repeat(1000)), "new_issue");

    expect(push.body.length).toBeLessThanOrEqual(240);
    expect(push.body.endsWith("…")).toBe(true);
  });

  it("lists the first three issues of a digest and counts the rest", () => {
    const items = [1, 2, 3, 4, 5].map((id) => ({
      issue: issue(id, `Error ${id}`),
      reason: "new_issue" as const,
    }));

    const push = digestPush(items);

    expect(push.title).toBe("5 issues in api");
    expect(push.body).toBe("API-1 Error 1\nAPI-2 Error 2\nAPI-3 Error 3\nand 2 more");
    expect(push.data).toEqual({ kind: "issues", organization: "acme", projectId: 3 });
  });

  it("refuses an empty digest, which would be a bug upstream", () => {
    expect(() => digestPush([])).toThrow(/at least one issue/);
    expect(() => summaryDigestPush([], 0)).toThrow(/at least one issue/);
  });

  it("leads with the model's summary and puts Zentry's own facts under it", () => {
    const push = summaryPush({
      issue: { ...issue(48, "System.Exception"), timesSeen: 1300 },
      reason: "new_issue",
      summary: SUMMARY,
      environment: "production",
    });

    expect(push).toEqual({
      channel: "alerts",
      title: "Discord rate limit blocking price alerts",
      body: "Discord is rate limiting the webhook, so price alerts likely failed to send.\nAPI-48 · production",
      data: { kind: "issue", organization: "acme", issueId: 48 },
    });
  });

  it("marks a regression and counts its events, and skips an unknown environment", () => {
    const push = summaryPush({
      issue: { ...issue(48, "System.Exception"), timesSeen: 1300 },
      reason: "regression",
      summary: SUMMARY,
      environment: "",
    });

    expect(push.title).toBe("Back again: Discord rate limit blocking price alerts");
    expect(push.body.endsWith("\nAPI-48 · 1.3K events")).toBe(true);
  });

  it("lists headlines in a summarized digest and counts the issues left out", () => {
    const items = [1, 2, 3].map((id) => ({
      issue: issue(id, `Error ${id}`),
      reason: "new_issue" as const,
      summary: { headline: `Headline ${id}`, detail: "d" },
      environment: "production",
    }));

    const push = summaryDigestPush(items, 5);

    expect(push.title).toBe("5 issues in api");
    expect(push.body).toBe("API-1 Headline 1\nAPI-2 Headline 2\nAPI-3 Headline 3\nand 2 more");
  });

  it.each([
    [7, "7"],
    [999, "999"],
    [1000, "1K"],
    [1300, "1.3K"],
    [1950, "2K"],
    [9999, "10K"],
    [12_345, "12.3K"],
    [999_999, "1M"],
    [1_250_000, "1.3M"],
    [1_000_000_000, "1B"],
  ])("writes %i as %s", (value, text) => {
    expect(compactCount(value)).toBe(text);
  });

  it("names who changed an issue, in the web UI's words", () => {
    const push = workflowPush(issue(7, "Boom"), { actor: "ana@example.com", status: "ignored" });

    expect(push.channel).toBe("workflow");
    expect(push.title).toBe("ana@example.com archived API-7");
  });

  it("words quota and spike pushes for the account they are about", () => {
    const organization = project.organization;
    const month = Date.UTC(2026, 10, 1);
    const nextMonth = Date.UTC(2026, 11, 1);

    expect(quotaPush({ organization, percent: 80, limit: 50_000, month, nextMonth }).title).toBe(
      "80% of the monthly cap used",
    );
    expect(quotaPush({ organization, percent: 100, limit: 50_000, month, nextMonth }).body).toBe(
      "Acme is refusing every event until the month ends (50,000 cap).",
    );
    expect(spikePush({ project, limit: 4167, until: NOW }).data).toEqual({
      kind: "issues",
      organization: "acme",
      projectId: 3,
    });
  });
});
