import { describe, expect, it } from "vitest";

import { extendWindow, intervalPassed, openWindow, secondsUntil } from "@/core/digest";
import { alertEmail } from "@/core/email-alert";
import { renderEmail } from "@/core/email-layout";
import { issueSubject, quotaEmail } from "@/core/email-messages";
import { resolveSetting, wantsWorkflow } from "@/core/notify-settings";
import type { SettingRow } from "@/core/notify-settings";
import { signUnsubscribe, verifyUnsubscribe } from "@/core/unsubscribe";
import type { EventSummary, IssueNotice } from "@/shared/notify";
import { MINUTE, SECOND } from "@/shared/time";

const NOW = Date.UTC(2026, 10, 17, 10, 30);

const target = { userId: 7, type: "alerts" as const, organizationId: 1, projectId: 3 };

describe("notification settings", () => {
  const row = (
    scope: SettingRow["scope"],
    scopeId: number,
    value: SettingRow["value"],
  ): SettingRow => ({
    userId: 7,
    type: "alerts",
    scope,
    scopeId,
    value,
  });

  it("falls back to the default with no rows", () => {
    expect(resolveSetting([], target)).toBe("always");
    expect(resolveSetting([], { ...target, type: "workflow" })).toBe("subscribe_only");
  });

  it("takes the most specific scope: project, then organization, then user", () => {
    const rows = [
      row("user", 7, "never"),
      row("organization", 1, "always"),
      row("project", 3, "never"),
    ];

    expect(resolveSetting(rows, target)).toBe("never");
    expect(resolveSetting(rows, { ...target, projectId: 4 })).toBe("always");
    expect(resolveSetting([row("user", 7, "never")], target)).toBe("never");
  });

  it("ignores rows for other users, types and scopes", () => {
    const rows = [
      { ...row("project", 3, "never"), userId: 8 },
      { ...row("project", 3, "never"), type: "quota" as const },
      row("organization", 2, "never"),
    ];

    expect(resolveSetting(rows, target)).toBe("always");
  });

  it("lets an explicit unfollow beat workflow set to all issues", () => {
    expect(wantsWorkflow("always", "none")).toBe(true);
    expect(wantsWorkflow("always", "unsubscribed")).toBe(false);
    expect(wantsWorkflow("subscribe_only", "subscribed")).toBe(true);
    expect(wantsWorkflow("subscribe_only", "none")).toBe(false);
    expect(wantsWorkflow("never", "subscribed")).toBe(false);
  });
});

describe("digest window", () => {
  it("is due 5 minutes after a send", () => {
    expect(openWindow(NOW)).toEqual({ startedAt: NOW, dueAt: NOW + 5 * MINUTE });
  });

  it("is pushed back 30 seconds past each alert, up to 30 minutes after the send", () => {
    const opened = openWindow(NOW);

    // Early alerts land inside the minimum delay and move nothing.
    expect(extendWindow(opened, NOW + MINUTE).dueAt).toBe(NOW + 5 * MINUTE);
    expect(extendWindow(opened, NOW + 5 * MINUTE).dueAt).toBe(NOW + 5 * MINUTE + 30 * SECOND);
    expect(extendWindow(opened, NOW + 40 * MINUTE).dueAt).toBe(NOW + 30 * MINUTE);
  });

  it("never moves the due time earlier", () => {
    const late = { startedAt: NOW, dueAt: NOW + 20 * MINUTE };

    expect(extendWindow(late, NOW + MINUTE).dueAt).toBe(NOW + 20 * MINUTE);
  });

  it("allows an issue one alert per 30 minutes", () => {
    expect(intervalPassed(NOW, NOW + 29 * MINUTE)).toBe(false);
    expect(intervalPassed(NOW, NOW + 30 * MINUTE)).toBe(true);
    expect(secondsUntil(NOW + 1500, NOW)).toBe(2);
    expect(secondsUntil(NOW - 1, NOW)).toBe(1);
  });
});

describe("unsubscribe tokens", () => {
  const link = { userId: 7, type: "alerts" as const, scope: "project" as const, scopeId: 3 };

  it("round-trips", async () => {
    const token = await signUnsubscribe(link, "secret");

    expect(await verifyUnsubscribe(token, "secret")).toEqual(link);
  });

  it("refuses an edited token, a token signed with another key, and garbage", async () => {
    const token = await signUnsubscribe(link, "secret");

    expect(await verifyUnsubscribe(token.replace("7.alerts", "8.alerts"), "secret")).toBeNull();
    expect(await verifyUnsubscribe(token.replace(".project.", ".user."), "secret")).toBeNull();
    expect(await verifyUnsubscribe(token, "other")).toBeNull();
    expect(await verifyUnsubscribe("7.alerts.project.3.!!!", "secret")).toBeNull();
    expect(await verifyUnsubscribe("", "secret")).toBeNull();
  });
});

const issue: IssueNotice = {
  id: 42,
  shortId: "API-12",
  title: "TypeError: <b>x</b> is undefined",
  culprit: "app/views.py in checkout",
  level: "error",
  message: "x is undefined",
  status: "unresolved",
  timesSeen: 1234,
  firstSeen: NOW,
  lastSeen: NOW,
  lastEventId: null,
  project: { id: 3, slug: "api", name: "API", organization: { id: 1, slug: "acme", name: "Acme" } },
};

const links = { appUrl: "https://zentry.test", unsubscribeUrl: "https://ingest.test/u?t=1" };

describe("emails", () => {
  it("names the issue in the subject, as Sentry does", () => {
    expect(issueSubject(issue)).toBe("API-12 - TypeError: <b>x</b> is undefined");
  });

  it("escapes the HTML part and keeps the plain-text part complete", () => {
    const email = alertEmail({ issue, reason: "new_issue", event: null }, links);

    expect(email.html).toContain("TypeError: &lt;b&gt;x&lt;/b&gt; is undefined");
    expect(email.html).not.toContain("<b>x</b>");
    expect(email.text).toContain("TypeError: <b>x</b> is undefined");
    expect(email.text).toContain("https://zentry.test/acme/issues/42/?referrer=alert_email");
    expect(email.text).toContain("1,234");
    expect(email.text).toContain("Unsubscribe: https://ingest.test/u?t=1");
    expect(email.html).toContain('href="https://ingest.test/u?t=1"');
  });

  it("shows the latest event's exception, user, message and tags, escaped and clipped", () => {
    const page = `<!DOCTYPE html><html><body>${"<p>stopped</p>".repeat(500)}</body></html>`;

    const event: EventSummary = {
      eventId: "cfd9d178ea0e4f21b169263d6bd84520",
      timestamp: NOW,
      environment: "Production",
      release: "1.0.0",
      platform: "csharp",
      transaction: null,
      url: null,
      runtime: null,
      message: "Failed to process the job",
      exceptions: [
        {
          type: "System.Exception",
          value: page,
          frames: [
            {
              module: null,
              filename: "lib.cs",
              function: "Lib",
              lineno: 3,
              colno: null,
              inApp: false,
              contextLine: null,
            },
            {
              module: null,
              filename: "Jobs.cs",
              function: "Run",
              lineno: 42,
              colno: null,
              inApp: true,
              contextLine: "  throw new Exception(body);",
            },
          ],
        },
      ],
      tags: [
        ["environment", "Production"],
        ["logger", "Hangfire"],
      ],
      user: { id: "96bc78d7", email: null, username: null, ipAddress: "129.151.163.89" },
    };

    const email = alertEmail({ issue, reason: "new_issue", event }, links);

    expect(email.html).not.toContain("<!DOCTYPE html><html><body><p>");
    expect(email.html).toContain("&lt;!DOCTYPE html&gt;");
    expect(email.html).toContain("System.Exception");
    expect(email.text).toContain(
      'File "Jobs.cs", line 42, in Run\n        throw new Exception(body);',
    );
    // Only in-app frames when there are any.
    expect(email.text).not.toContain("lib.cs");
    expect(email.text).toContain("ID: 96bc78d7");
    expect(email.text).toContain("IP Address: 129.151.163.89");
    expect(email.text).toContain("logger = Hangfire");
    expect(email.text).toContain("Environment: Production");
    expect(email.text).toContain("ID: cfd9d178ea0e4f21b169263d6bd84520");
    // The page is clipped, not sent whole.
    expect(email.html.length).toBeLessThan(20_000);
  });

  it("leaves the unsubscribe link out when there is none", () => {
    const email = renderEmail({
      subject: "s",
      blocks: [{ kind: "paragraph", text: "hello" }],
      footer: { reason: "r", settingsUrl: "https://zentry.test/s", unsubscribeUrl: null },
    });

    expect(email.text).toBe("hello\n\n--\nr\nNotification settings: https://zentry.test/s");
    expect(email.html).not.toContain("Unsubscribe");
  });

  it("says when the monthly cap is reached and when events are accepted again", () => {
    const email = quotaEmail(
      {
        organization: issue.project.organization,
        percent: 100,
        limit: 1_000_000,
        month: Date.UTC(2026, 10, 1),
        nextMonth: Date.UTC(2026, 11, 1),
      },
      links,
    );

    expect(email.subject).toBe("[Zentry] Acme has used 100% of its monthly events");
    expect(email.text).toContain("refuses every event until Dec 1");
  });
});
