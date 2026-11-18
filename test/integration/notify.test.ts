import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { processMessages } from "@/consumer/handler";
import { signUnsubscribe } from "@/core/unsubscribe";
import { sweepOutbox } from "@/cron/notify";
import { IssueStore } from "@/db/issues";
import { NotificationSettingsStore } from "@/db/notify-settings";
import { flushDigest } from "@/notify/alerts";
import type { MailDeps } from "@/notify/deps";
import { drainOutbox } from "@/notify/handler";
import { handleUnsubscribe, UNSUBSCRIBE_PATH } from "@/notify/unsubscribe";
import type { ApiNotificationSettings } from "@/shared/contract";
import { DAY, MINUTE } from "@/shared/time";

import { api } from "./api-helpers";
import {
  consumerDeps,
  createOrganization,
  createProject,
  errorEvent,
  groupsOf,
  message,
  NOW,
} from "./helpers";
import { addMember, errorWithCode, notifyHarness, outboxKinds } from "./notify-helpers";
import type { Harness } from "./notify-helpers";

let index = 0;
let woken = 0;

/** Sends one error event through the real consumer. */
async function send(projectId: number, functionName: string, receivedAt = NOW): Promise<void> {
  index += 1;

  await processMessages(
    [message({ projectId, index, event: errorEvent(functionName), receivedAt })],
    consumerDeps({
      notify: async () => {
        woken += 1;
      },
      now: () => receivedAt,
    }),
  );
}

async function drainAll(harness: Harness): Promise<void> {
  for (let round = 0; round < 50; round += 1) {
    await drainOutbox(harness.deps);

    if ((await outboxKinds()).length === 0) {
      return;
    }
  }

  throw new Error("the outbox did not empty");
}

function mailDeps(harness: Harness): MailDeps {
  const { config } = harness.deps;

  if (config === null) {
    throw new Error("the harness always configures email");
  }

  return { ...harness.deps, config };
}

async function setting(
  userId: number,
  change: {
    type: "alerts" | "workflow";
    scope: "organization" | "project";
    scopeId: number;
    value: "always" | "never";
  },
): Promise<void> {
  await new NotificationSettingsStore(env.DB).set({ userId, ...change }, NOW);
}

async function setup(): Promise<{
  organizationId: number;
  projectId: number;
  alice: { id: number; email: string };
  bob: { id: number; email: string };
}> {
  const organizationId = await createOrganization(1_000_000);
  const project = await createProject(null, organizationId);
  const alice = await addMember(organizationId);
  const bob = await addMember(organizationId);

  return { organizationId, projectId: project.id, alice, bob };
}

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM notify_outbox`).run();
  woken = 0;
});

describe("issue alerts", () => {
  it("queues a new issue in the commit and emails each member once", async () => {
    const { projectId, alice, bob } = await setup();

    await send(projectId, "checkout");

    expect(await outboxKinds()).toEqual(["new_issue"]);
    expect(woken).toBe(1);

    const harness = notifyHarness();

    await drainAll(harness);

    expect(harness.sent.map((email) => email.to).toSorted()).toEqual(
      [alice.email, bob.email].toSorted(),
    );

    const [first] = harness.sent;

    expect(first?.subject).toMatch(/^P\d+-[A-Z0-9]+-1 - ValueError: boom$/);
    expect(first?.headers?.["List-Unsubscribe"]).toMatch(
      /^<https:\/\/ingest\.zentry\.test\/notifications\/unsubscribe\?t=/,
    );
    expect(first?.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    // The latest event, read back from R2, fills in the detail.
    expect(first?.text).toContain("New issue");
    expect(first?.text).toContain("Exception\n---------\n\n    ValueError: boom");
    expect(first?.text).toMatch(/ID: [0-9a-f]{32}/);
    expect(harness.scheduled).toEqual([{ projectId, delaySeconds: 300 }]);
  });

  it("does not resend to members who already got the email when a delivery is retried", async () => {
    const { projectId, alice, bob } = await setup();

    await send(projectId, "checkout");

    const flaky = notifyHarness((to) =>
      to === bob.email ? errorWithCode("E_RATE_LIMIT_EXCEEDED") : null,
    );

    await expect(drainOutbox(flaky.deps)).rejects.toThrow(/E_RATE_LIMIT_EXCEEDED/);
    expect(flaky.sent.map((email) => email.to)).toEqual([alice.email]);
    expect(await outboxKinds()).toEqual(["new_issue"]);

    const healthy = notifyHarness();

    await drainAll(healthy);

    expect(healthy.sent.map((email) => email.to)).toEqual([bob.email]);
  });

  it("leaves a row untouched when Cloudflare asks to try later, however often", async () => {
    const { projectId } = await setup();

    await send(projectId, "checkout");

    const limited = notifyHarness(() => errorWithCode("E_RATE_LIMIT_EXCEEDED"));

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await expect(drainOutbox(limited.deps)).rejects.toThrow(/E_RATE_LIMIT_EXCEEDED/);
    }

    const row = await env.DB.prepare(`SELECT attempts FROM notify_outbox`).first<{
      attempts: number;
    }>();

    expect(row?.attempts).toBe(0);

    const healthy = notifyHarness();

    await drainAll(healthy);
    expect(healthy.sent).toHaveLength(2);
  });

  it("re-requests the flush of a digest window whose message was lost", async () => {
    const { projectId } = await setup();
    const harness = notifyHarness();
    const scheduled: number[] = [];

    await harness.deps.store.saveDigestWindow(projectId, {
      startedAt: NOW - 40 * MINUTE,
      dueAt: NOW - 30 * MINUTE,
    });

    await sweepOutbox({
      queueWeeklyReports: async () => 0,
      outboxSize: () => harness.deps.store.outboxSize(),
      overdueDigests: (now, grace) => harness.deps.store.overdueDigests(now, grace),
      scheduleDigest: async (id) => {
        scheduled.push(id);
      },
      notify: async () => {},
      now: () => NOW,
    });

    expect(scheduled).toContain(projectId);
  });

  it("holds alerts inside the digest window and sends them together when it is due", async () => {
    const { projectId, alice } = await setup();
    const harness = notifyHarness();

    await send(projectId, "first");
    await drainAll(harness);
    expect(harness.sent).toHaveLength(2);

    await send(projectId, "second", NOW + MINUTE);
    await send(projectId, "third", NOW + 2 * MINUTE);
    harness.advance(2 * MINUTE);
    await drainAll(harness);

    // Held, not sent.
    expect(harness.sent).toHaveLength(2);

    // Not yet due: the flush asks to run again later.
    await flushDigest(mailDeps(harness), projectId);
    expect(harness.sent).toHaveLength(2);
    expect(harness.scheduled.at(-1)?.delaySeconds).toBe(180);

    harness.advance(3 * MINUTE);
    await flushDigest(mailDeps(harness), projectId);

    const digests = harness.sent.slice(2);

    expect(digests.map((email) => email.to)).toContain(alice.email);
    expect(digests[0]?.subject).toMatch(/ - 2 new alerts since /);
    expect(digests[0]?.text).toContain("ValueError: boom");

    // The next window starts at the send; with nothing held it closes quietly.
    harness.advance(5 * MINUTE);
    await flushDigest(mailDeps(harness), projectId);
    expect(harness.sent).toHaveLength(4);
  });

  it("alerts on a regression, and not for a member who turned the project off", async () => {
    const { organizationId, projectId, alice, bob } = await setup();

    await send(projectId, "checkout");

    const [group] = await groupsOf(projectId);

    await new IssueStore(env.DB).setStatus({
      organizationId,
      issueIds: [group?.id ?? 0],
      status: "resolved",
      userId: alice.id,
      now: NOW + MINUTE,
    });

    await env.DB.prepare(`DELETE FROM notify_outbox`).run();
    await setting(bob.id, { type: "alerts", scope: "project", scopeId: projectId, value: "never" });
    await send(projectId, "checkout", NOW + 2 * MINUTE);

    expect(await outboxKinds()).toEqual(["regression"]);

    const harness = notifyHarness();

    await drainAll(harness);

    expect(harness.sent.map((email) => email.to)).toEqual([alice.email]);
    expect(harness.sent[0]?.text).toContain("Regressed issue");
  });

  it("stops sending to an address Cloudflare suppresses, for a week", async () => {
    const { projectId, alice, bob } = await setup();

    await send(projectId, "checkout");

    const harness = notifyHarness((to) =>
      to === bob.email ? errorWithCode("E_RECIPIENT_SUPPRESSED") : null,
    );

    await drainAll(harness);

    const row = await env.DB.prepare(`SELECT until FROM email_suppressions WHERE address = ?1`)
      .bind(bob.email)
      .first<{ until: number }>();

    expect(row?.until).toBe(NOW + 7 * DAY);

    const next = await createProject(
      null,
      (
        await env.DB.prepare(`SELECT organization_id AS o FROM projects WHERE id = ?1`)
          .bind(projectId)
          .first<{ o: number }>()
      )?.o ?? 0,
    );

    await send(next.id, "other");

    const later = notifyHarness();

    await drainAll(later);

    expect(later.sent.map((email) => email.to)).toEqual([alice.email]);
  });
});

describe("workflow emails", () => {
  it("emails followers and members who want every issue, but never the actor", async () => {
    const { organizationId, projectId, alice, bob } = await setup();
    const harness = notifyHarness();

    await send(projectId, "checkout");
    await drainAll(harness);

    const [group] = await groupsOf(projectId);
    const issues = new IssueStore(env.DB);
    const change = { organizationId, issueIds: [group?.id ?? 0], userId: alice.id };

    // Bob does not follow the issue, so the default sends him nothing.
    await issues.setStatus({ ...change, status: "resolved", now: NOW + MINUTE });
    await drainAll(harness);
    expect(harness.sent).toHaveLength(2);

    // With workflow on for every issue, Bob hears when Alice archives it.
    await setting(bob.id, {
      type: "workflow",
      scope: "organization",
      scopeId: organizationId,
      value: "always",
    });
    await issues.setStatus({ ...change, status: "ignored", now: NOW + 2 * MINUTE });
    await drainAll(harness);

    const [workflow] = harness.sent.slice(2);

    expect(harness.sent).toHaveLength(3);
    expect(workflow?.to).toBe(bob.email);
    expect(workflow?.text).toContain(`${alice.email} archived`);
    // It replies to the alert Bob got about the same issue.
    expect(workflow?.headers?.["In-Reply-To"]).toMatch(/^<m\d+@zentry\.test>$/);

    // Alice followed the issue by acting on it, so Bob reopening it reaches her.
    await issues.setStatus({
      ...change,
      userId: bob.id,
      status: "unresolved",
      now: NOW + 3 * MINUTE,
    });
    await drainAll(harness);
    expect(harness.sent.at(-1)?.to).toBe(alice.email);
    expect(harness.sent.at(-1)?.text).toContain(`${bob.email} reopened`);
  });
});

describe("quota emails", () => {
  it("queues one email at 80% and one at 100% of the monthly cap", async () => {
    const organizationId = await createOrganization(10);
    const project = await createProject(null, organizationId);
    const member = await addMember(organizationId);

    for (let n = 0; n < 8; n += 1) {
      await send(project.id, "checkout");
    }

    expect((await outboxKinds()).filter((kind) => kind === "quota")).toHaveLength(1);

    await send(project.id, "checkout");
    await send(project.id, "checkout");
    await send(project.id, "checkout");

    expect((await outboxKinds()).filter((kind) => kind === "quota")).toHaveLength(2);

    const harness = notifyHarness();

    await drainAll(harness);

    const subjects = harness.sent
      .filter((email) => email.to === member.email)
      .map((email) => email.subject);

    expect(subjects).toContain("[Zentry] Test has used 80% of its monthly events");
    expect(subjects).toContain("[Zentry] Test has used 100% of its monthly events");
  });
});

describe("spike protection emails", () => {
  it("emails once when spike protection starts refusing a project", async () => {
    const { organizationId, projectId, alice } = await setup();

    await env.DB.prepare(`UPDATE projects SET spike_limit_per_hour = 2 WHERE id = ?1`)
      .bind(projectId)
      .run();

    await send(projectId, "checkout");
    await send(projectId, "checkout");
    expect(await outboxKinds()).toEqual(["new_issue"]);

    await send(projectId, "checkout");
    expect(await outboxKinds()).toEqual(["new_issue", "spike"]);

    // Already refusing: no second email for the same hour.
    await send(projectId, "checkout");
    expect(await outboxKinds()).toEqual(["new_issue", "spike"]);

    const harness = notifyHarness();

    await drainAll(harness);

    const spike = harness.sent.find(
      (email) => email.to === alice.email && email.subject.includes("Spike"),
    );

    expect(spike?.subject).toMatch(/^\[Zentry\] Spike protection is refusing events for p\d+-/);
    expect(spike?.text).toContain(`/settings/projects/`);
    expect(organizationId).toBeGreaterThan(1);
  });
});

describe("weekly reports", () => {
  it("reports a busy week and skips a quiet organization", async () => {
    const { projectId, alice } = await setup();
    const quiet = await addMember(await createOrganization(1_000_000));

    await send(projectId, "checkout");
    await env.DB.prepare(`DELETE FROM notify_outbox`).run();

    const harness = notifyHarness();

    await harness.deps.store.queueWeeklyReports({ start: NOW - DAY, end: NOW + DAY }, NOW);
    await drainAll(harness);

    const report = harness.sent.find((email) => email.to === alice.email);

    expect(report?.subject).toMatch(/^\[Zentry\] Weekly Report for Test: /);
    expect(report?.text).toContain("Errors: 1");
    expect(harness.sent.some((email) => email.to === quiet.email)).toBe(false);
  });
});

describe("unsubscribe links", () => {
  async function unsubscribeRequest(method: string, token: string): Promise<Response> {
    const url = `https://ingest.zentry.test${UNSUBSCRIBE_PATH}?t=${encodeURIComponent(token)}`;
    const harness = notifyHarness();

    return handleUnsubscribe(new Request(url, { method }), {
      store: harness.deps.store,
      settings: harness.deps.settings,
      signingKey: "test-signing-key",
      now: () => NOW,
    });
  }

  it("asks on GET and turns the email off on POST", async () => {
    const { organizationId, projectId, alice } = await setup();

    const token = await signUnsubscribe(
      { userId: alice.id, type: "alerts", scope: "project", scopeId: projectId },
      "test-signing-key",
    );

    const settings = new NotificationSettingsStore(env.DB);

    const asked = await unsubscribeRequest("GET", token);

    expect(asked.status).toBe(200);
    expect(await asked.text()).toContain('<form method="post"');
    expect(await settings.forUser(alice.id, organizationId)).toEqual([]);

    const done = await unsubscribeRequest("POST", token);

    expect(done.status).toBe(200);
    expect(await done.text()).toContain("You will no longer get issue alerts for");
    expect(await settings.forUser(alice.id, organizationId)).toEqual([
      { userId: alice.id, type: "alerts", scope: "project", scopeId: projectId, value: "never" },
    ]);
  });

  it("unfollows one issue", async () => {
    const { projectId, alice } = await setup();

    await send(projectId, "checkout");

    const [group] = await groupsOf(projectId);
    const groupId = group?.id ?? 0;
    const settings = new NotificationSettingsStore(env.DB);

    await settings.setSubscription({ userId: alice.id, active: true }, groupId, NOW);

    const token = await signUnsubscribe(
      { userId: alice.id, type: "workflow", scope: "issue", scopeId: groupId },
      "test-signing-key",
    );

    expect((await unsubscribeRequest("POST", token)).status).toBe(200);
    expect(await settings.isSubscribed(alice.id, groupId)).toBe(false);
  });

  it("refuses a token that was changed", async () => {
    const { projectId, alice } = await setup();

    const token = await signUnsubscribe(
      { userId: alice.id, type: "alerts", scope: "project", scopeId: projectId },
      "test-signing-key",
    );

    const forged = token.replace(`${alice.id}.alerts`, `${alice.id + 1}.alerts`);

    expect((await unsubscribeRequest("POST", forged)).status).toBe(400);
    expect((await unsubscribeRequest("POST", "")).status).toBe(400);
    expect((await unsubscribeRequest("DELETE", token)).status).toBe(405);
  });
});

describe("notification settings API", () => {
  async function read(response: Response): Promise<ApiNotificationSettings> {
    expect(response.status).toBe(200);

    return response.json<ApiNotificationSettings>();
  }

  it("lists the defaults and saves and clears a choice", async () => {
    const initial = await read(await api("/organizations/default/notifications/"));

    expect(initial.defaults.workflow).toBe("subscribe_only");
    expect(initial.emailEnabled).toBe(true);

    const change = { type: "reports", scope: "organization", scopeId: 1 };

    const saved = await read(
      await api("/organizations/default/notifications/", {
        method: "PUT",
        body: { ...change, value: "never" },
      }),
    );

    expect(saved.settings).toContainEqual({ ...change, value: "never" });

    const cleared = await read(
      await api("/organizations/default/notifications/", {
        method: "PUT",
        body: { ...change, value: null },
      }),
    );

    expect(cleared.settings).not.toContainEqual({ ...change, value: "never" });
  });

  it("refuses values, scopes and ids that do not fit", async () => {
    const put = async (body: {
      type: string;
      scope: string;
      scopeId: number;
      value: string;
    }): Promise<number> =>
      (await api("/organizations/default/notifications/", { method: "PUT", body })).status;

    expect(
      await put({ type: "alerts", scope: "organization", scopeId: 1, value: "subscribe_only" }),
    ).toBe(400);
    expect(await put({ type: "quota", scope: "project", scopeId: 1, value: "never" })).toBe(400);
    expect(await put({ type: "alerts", scope: "organization", scopeId: 999, value: "never" })).toBe(
      400,
    );
    expect(await put({ type: "alerts", scope: "project", scopeId: 999_999, value: "never" })).toBe(
      400,
    );
    expect(await put({ type: "alerts", scope: "user", scopeId: 999_999, value: "never" })).toBe(
      400,
    );
  });

  it("follows and unfollows an issue", async () => {
    const project = await createProject();

    await send(project.id, "checkout");

    const [group] = await groupsOf(project.id);
    const path = `/organizations/default/issues/${group?.id}/subscription/`;

    expect(await (await api(path)).json()).toEqual({ subscribed: false });
    expect(await (await api(path, { method: "PUT", body: { subscribed: true } })).json()).toEqual({
      subscribed: true,
    });
    expect(await (await api(path)).json()).toEqual({ subscribed: true });
  });
});
