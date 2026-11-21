import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { processMessages } from "@/consumer/handler";
import { PROMPT_VERSION } from "@/core/issue-summary";
import { checkPushReceipts } from "@/cron/push-receipts";
import type { PushReceiptDeps } from "@/cron/push-receipts";
import { DeviceStore } from "@/db/devices";
import { IssueSummaryStore } from "@/db/issue-summaries";
import { IssueStore } from "@/db/issues";
import { NotifyStore } from "@/db/notify";
import { NotificationSettingsStore } from "@/db/notify-settings";
import { PushSendStore } from "@/db/pushes";
import { flushDigest } from "@/notify/alerts";
import { drainOutbox } from "@/notify/handler";
import type { NotificationType } from "@/shared/contract";
import type { AlertReason, IssueSummary } from "@/shared/notify";
import type { PushReceipt } from "@/shared/push";
import { DAY, MINUTE } from "@/shared/time";

import {
  consumerDeps,
  createOrganization,
  createProject,
  errorEvent,
  groupsOf,
  message,
  NOW,
} from "./helpers";
import {
  addMember,
  errorWithCode,
  notifyHarness,
  outboxKinds,
  TEST_SUMMARY,
} from "./notify-helpers";
import type { Harness } from "./notify-helpers";

let index = 0;

async function send(projectId: number, functionName: string, receivedAt = NOW): Promise<void> {
  index += 1;

  await processMessages(
    [message({ projectId, index, event: errorEvent(functionName), receivedAt })],
    consumerDeps({ notify: async () => {}, now: () => receivedAt }),
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

let phones = 0;

/** A signed-in phone with a push token, for the user. */
async function phone(userId: number): Promise<{ deviceId: number; pushToken: string }> {
  phones += 1;

  const devices = new DeviceStore(env.DB);
  const pushToken = `ExponentPushToken[phone-${phones}]`;

  const device = await devices.create(
    { userId, tokenHash: `hash-${phones}-${crypto.randomUUID()}`, name: `Phone ${phones}` },
    NOW,
  );

  await devices.setPushToken(device.id, pushToken);

  return { deviceId: device.id, pushToken };
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

async function turnOff(
  userId: number,
  type: NotificationType,
  organizationId: number,
): Promise<void> {
  await new NotificationSettingsStore(env.DB).set(
    {
      provider: "push",
      userId,
      type,
      scope: "organization",
      scopeId: organizationId,
      value: "never",
    },
    NOW,
  );
}

beforeEach(async () => {
  await env.DB.prepare(`DELETE FROM notify_outbox`).run();
});

describe("push alerts", () => {
  it("pushes a new issue to every phone of every member, on the alerts channel", async () => {
    const { projectId, alice, bob } = await setup();
    const alicePhone = await phone(alice.id);
    const aliceTablet = await phone(alice.id);
    const bobPhone = await phone(bob.id);
    const harness = notifyHarness();

    await send(projectId, "checkout");
    await drainAll(harness);

    expect(harness.pushed.map((push) => push.to).toSorted()).toEqual(
      [alicePhone.pushToken, aliceTablet.pushToken, bobPhone.pushToken].toSorted(),
    );

    const [first] = harness.pushed;
    const [group] = await groupsOf(projectId);

    expect(first?.channelId).toBe("alerts");
    expect(first?.title).toBe(TEST_SUMMARY.headline);
    expect(first?.body).toMatch(
      new RegExp(`^${TEST_SUMMARY.detail}\\nP\\d+-[A-Z0-9]+-1 · production$`, "u"),
    );
    expect(first?.data).toMatchObject({ kind: "issue", issueId: group?.id });
    // The model was asked once, from the stored event, for all three phones.
    expect(harness.prompts).toHaveLength(1);
    expect(harness.prompts[0]?.user).toContain('"value":"boom"');
    // Email still goes out alongside.
    expect(harness.sent).toHaveLength(2);
  });

  it("respects each member's push setting apart from their email setting", async () => {
    const { organizationId, projectId, alice, bob } = await setup();

    await phone(alice.id);

    const bobPhone = await phone(bob.id);
    const harness = notifyHarness();

    await turnOff(alice.id, "alerts", organizationId);
    await send(projectId, "checkout");
    await drainAll(harness);

    expect(harness.pushed.map((push) => push.to)).toEqual([bobPhone.pushToken]);
    // Alice turned off push, not email.
    expect(harness.sent.map((email) => email.to)).toContain(alice.email);
  });

  it("still pushes while email is not configured", async () => {
    const { projectId, alice } = await setup();
    const alicePhone = await phone(alice.id);
    const harness = notifyHarness();

    harness.deps.config = null;
    await send(projectId, "checkout");
    await drainAll(harness);

    expect(harness.sent).toEqual([]);
    expect(harness.pushed.map((push) => push.to)).toEqual([alicePhone.pushToken]);
  });

  it("leaves the row for later when Expo asks to wait, then pushes once", async () => {
    const { projectId, alice } = await setup();

    await phone(alice.id);

    const harness = notifyHarness();

    harness.replyToPush(() => ({ ok: false, retryable: true, error: "HTTP 503: busy" }));
    await send(projectId, "checkout");

    await expect(drainOutbox(harness.deps)).rejects.toThrow(/deferred/);
    expect(await outboxKinds()).toEqual(["new_issue"]);

    const row = await env.DB.prepare(`SELECT attempts FROM notify_outbox`).first<{
      attempts: number;
    }>();

    expect(row?.attempts).toBe(0);

    const emailed = harness.sent.length;

    harness.replyToPush((messages) => ({
      ok: true,
      value: messages.map(() => ({ status: "ok", id: "ticket" })),
    }));
    // The retry is a new queue batch, once the row is due again.
    harness.deps.paused.clear();
    harness.advance(5 * MINUTE);
    await drainAll(harness);

    expect(harness.pushed).toHaveLength(1);
    // The emails that went out before Expo refused are not sent again.
    expect(harness.sent).toHaveLength(emailed);
  });

  it("forgets a push token Expo no longer knows", async () => {
    const { projectId, alice } = await setup();
    const alicePhone = await phone(alice.id);
    const harness = notifyHarness();

    harness.replyToPush((messages) => ({
      ok: true,
      value: messages.map(() => ({
        status: "error",
        message: "not a registered push notification recipient",
        error: "DeviceNotRegistered",
      })),
    }));
    await send(projectId, "checkout");
    await drainAll(harness);

    expect(await new DeviceStore(env.DB).pushTargets([alice.id])).toEqual([]);

    const row = await env.DB.prepare(`SELECT status, error FROM push_sends WHERE device_id = ?1`)
      .bind(alicePhone.deviceId)
      .first<{ status: string; error: string }>();

    expect(row?.status).toBe("failed");
    expect(row?.error).toContain("DeviceNotRegistered");
  });
});

describe("push and email apart", () => {
  it("keeps pushing while email waits, without calling email again that drain", async () => {
    const { projectId, alice } = await setup();
    const alicePhone = await phone(alice.id);
    let emailCalls = 0;

    // Cloudflare's daily email cap is reached.
    const harness = notifyHarness(() => {
      emailCalls += 1;

      return errorWithCode("E_DAILY_LIMIT_EXCEEDED");
    });

    await send(projectId, "checkout");
    await send(projectId, "payments");
    await expect(drainOutbox(harness.deps)).rejects.toThrow(/2 of 2 notifications deferred/);

    // Both issues pushed; email tried once, then paused for the drain.
    expect(harness.pushed.map((push) => push.to)).toEqual([
      alicePhone.pushToken,
      alicePhone.pushToken,
    ]);
    expect(emailCalls).toBe(1);
    expect(await outboxKinds()).toEqual(["new_issue", "new_issue"]);

    // The deferred rows step aside, so a row behind them is drained now.
    harness.advance(MINUTE);
    harness.deps.paused.clear();
    await send(projectId, "search", NOW + MINUTE);
    await expect(drainOutbox(harness.deps)).rejects.toThrow(/1 of 1 notifications deferred/);
    expect(harness.pushed).toHaveLength(3);
  });

  it("still sends email while Expo waits", async () => {
    const { projectId, alice } = await setup();

    await phone(alice.id);

    const harness = notifyHarness();

    harness.replyToPush(() => ({ ok: false, retryable: true, error: "HTTP 429: slow down" }));
    await send(projectId, "checkout");
    await expect(drainOutbox(harness.deps)).rejects.toThrow(/deferred/);

    expect(harness.sent.map((email) => email.to)).toContain(alice.email);
    expect(harness.pushed).toEqual([]);
  });
});

describe("push batches", () => {
  it("sends each push alone when Expo refuses a mixed batch, so one bad token fails alone", async () => {
    const { projectId, alice, bob } = await setup();
    const good = await phone(alice.id);
    const bad = await phone(bob.id);
    const harness = notifyHarness();

    // Expo refuses a request mixing tokens of two Expo projects.
    harness.replyToPush((messages) =>
      messages.length > 1
        ? { ok: false, retryable: false, error: "HTTP 400: PUSH_TOO_MANY_EXPERIENCE_IDS" }
        : messages[0]?.to === bad.pushToken
          ? { ok: false, retryable: false, error: "HTTP 400: wrong project" }
          : { ok: true, value: [{ status: "ok", id: "t" }] },
    );
    await send(projectId, "checkout");
    await drainAll(harness);

    expect(harness.pushed.map((push) => push.to)).toEqual([good.pushToken]);

    const row = await env.DB.prepare(`SELECT status, error FROM push_sends WHERE device_id = ?1`)
      .bind(bad.deviceId)
      .first<{ status: string; error: string }>();

    expect(row).toEqual({ status: "failed", error: "HTTP 400: wrong project" });
  });

  it("splits more than a hundred phones into requests Expo accepts", async () => {
    const { projectId, alice } = await setup();

    for (let count = 0; count < 101; count += 1) {
      await phone(alice.id);
    }

    const harness = notifyHarness();
    const sizes: number[] = [];

    harness.replyToPush((messages) => {
      sizes.push(messages.length);

      return { ok: true, value: messages.map(() => ({ status: "ok", id: "t" })) };
    });
    await send(projectId, "checkout");
    await drainAll(harness);

    expect(sizes).toEqual([100, 1]);
  });
});

describe("push kinds", () => {
  it("pushes a digest once for the alerts its window held", async () => {
    const { projectId, alice } = await setup();
    const harness = notifyHarness();

    await phone(alice.id);
    await send(projectId, "first");
    await drainAll(harness);
    await send(projectId, "second", NOW + MINUTE);
    await send(projectId, "third", NOW + 2 * MINUTE);
    harness.advance(2 * MINUTE);
    await drainAll(harness);
    expect(harness.pushed).toHaveLength(1);

    harness.advance(5 * MINUTE);
    await flushDigest(harness.deps, projectId);

    expect(harness.pushed.map((push) => push.title)).toEqual([
      TEST_SUMMARY.headline,
      expect.stringMatching(/^2 issues in /),
    ]);

    expect(harness.pushed[1]?.body).toMatch(
      new RegExp(`^P\\d+-[A-Z0-9]+-2 ${TEST_SUMMARY.headline}\\nP\\d+-[A-Z0-9]+-3 `, "u"),
    );
  });

  it("never pushes the weekly report, with or without email", async () => {
    const { projectId, alice } = await setup();

    await phone(alice.id);
    await send(projectId, "checkout");
    await env.DB.prepare(`DELETE FROM notify_outbox`).run();

    for (const emailOn of [true, false]) {
      const harness = notifyHarness();

      if (!emailOn) {
        harness.deps.config = null;
      }

      await harness.deps.store.queueWeeklyReports({ start: NOW - DAY, end: NOW + DAY }, NOW);
      await drainAll(harness);

      expect(harness.pushed).toEqual([]);
      expect(harness.sent.length > 0).toBe(emailOn);
    }
  });
});

/** Sends everything, then fails to delete the row: the delivery is retried. */
class CrashAfterSending extends NotifyStore {
  override async handled(): Promise<void> {
    throw new Error("crashed before the row was deleted");
  }
}

async function bobFollowsEverything(organizationId: number, bobId: number): Promise<void> {
  await new NotificationSettingsStore(env.DB).set(
    {
      provider: "push",
      userId: bobId,
      type: "workflow",
      scope: "organization",
      scopeId: organizationId,
      value: "always",
    },
    NOW,
  );
}

/** Sends the alert, then fails to record it once: the alert is sent again. */
class FailFirstRecord extends NotifyStore {
  #failed = false;

  override async recordAlert(groupId: number, reason: AlertReason, now: number): Promise<void> {
    if (!this.#failed) {
      this.#failed = true;

      throw new Error("crashed before the alert was recorded");
    }

    await super.recordAlert(groupId, reason, now);
  }
}

/** A summary store whose first lookup fails, as D1 might. */
class FailFirstLookup extends IssueSummaryStore {
  #failed = false;

  override async get(groupId: number, promptVersion: number): Promise<IssueSummary | null> {
    if (!this.#failed) {
      this.#failed = true;

      throw new Error("D1 is unavailable");
    }

    return super.get(groupId, promptVersion);
  }
}

describe("push summaries", () => {
  async function summaryRows(): Promise<number> {
    const row = await env.DB.prepare(`SELECT count(*) AS n FROM issue_summaries`).first<{
      n: number;
    }>();

    return row?.n ?? 0;
  }

  beforeEach(async () => {
    await env.DB.prepare(`DELETE FROM issue_summaries`).run();
  });

  it("sends today's plain push and logs it when the model fails, and keeps nothing", async () => {
    const { projectId, alice } = await setup();
    const harness = notifyHarness();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await phone(alice.id);
    harness.replyToSummary(() => ({ ok: false, error: "Workers AI: 3021: rate limiting" }));
    await send(projectId, "checkout");
    await drainAll(harness);

    expect(harness.pushed[0]?.title).toMatch(/^New issue in /);
    expect(harness.pushed[0]?.body).toContain("ValueError: boom");
    expect(harness.sent).toHaveLength(2);
    expect(await summaryRows()).toBe(0);
    expect(logged.mock.calls.flat().join("\n")).toContain("push summary failed");
    logged.mockRestore();
  });

  it("writes an issue's summary once and reuses it when the issue regresses", async () => {
    const { organizationId, projectId, alice } = await setup();
    const harness = notifyHarness();

    await phone(alice.id);
    await send(projectId, "checkout");
    await drainAll(harness);

    const [group] = await groupsOf(projectId);

    await new IssueStore(env.DB).setStatus({
      organizationId,
      issueIds: [group?.id ?? 0],
      userId: alice.id,
      status: "resolved",
      now: NOW + MINUTE,
    });

    await env.DB.prepare(`DELETE FROM notify_outbox`).run();
    await send(projectId, "checkout", NOW + 2 * MINUTE);
    await drainAll(harness);
    harness.advance(6 * MINUTE);
    await flushDigest(harness.deps, projectId);

    expect(harness.pushed.map((push) => push.title)).toEqual([
      TEST_SUMMARY.headline,
      `Back again: ${TEST_SUMMARY.headline}`,
    ]);

    expect(harness.pushed[1]?.body).toMatch(/\nP\d+-[A-Z0-9]+-1 · production · 2 events$/u);
    expect(harness.prompts).toHaveLength(1);
    expect(await summaryRows()).toBe(1);
  });

  it("does not ask the model when no phone wants the push", async () => {
    const { projectId } = await setup();
    const harness = notifyHarness();

    await send(projectId, "checkout");
    await drainAll(harness);

    expect(harness.prompts).toEqual([]);
    expect(harness.sent).toHaveLength(2);
  });

  it("does not ask the model again when a retry finds every push already sent", async () => {
    const { projectId, alice } = await setup();
    const harness = notifyHarness();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await phone(alice.id);
    // No summary is stored, so only the claimed push can stop a second call.
    harness.replyToSummary(() => ({ ok: false, error: "Workers AI: 3021: rate limiting" }));
    harness.deps.store = new FailFirstRecord(env.DB);
    await send(projectId, "checkout");
    await expect(drainOutbox(harness.deps)).rejects.toThrow(/notifications failed/);
    await drainAll(harness);

    expect(harness.pushed).toHaveLength(1);
    expect(harness.prompts).toHaveLength(1);
    logged.mockRestore();
  });

  it("retries instead of summarizing from less when the event cannot be read", async () => {
    const { projectId, alice } = await setup();
    const harness = notifyHarness();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const read = harness.deps.latestEvent;
    let failures = 1;

    harness.deps.latestEvent = async (issue) => {
      if (failures > 0) {
        failures -= 1;

        throw new Error("R2 is unavailable");
      }

      return read(issue);
    };

    await phone(alice.id);
    await send(projectId, "checkout");
    await expect(drainOutbox(harness.deps)).rejects.toThrow(/notifications failed/);

    expect(harness.pushed).toEqual([]);
    expect(harness.prompts).toEqual([]);

    await drainAll(harness);

    const row = await env.DB.prepare(`SELECT event_id FROM issue_summaries`).first<{
      event_id: string | null;
    }>();

    expect(harness.pushed).toHaveLength(1);
    expect(harness.prompts[0]?.user).toContain('"platform":"python"');
    expect(row?.event_id).not.toBeNull();
    logged.mockRestore();
  });

  it("sends exactly once after the summary store fails", async () => {
    const { projectId, alice } = await setup();
    const harness = notifyHarness();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    harness.deps.summaries = new FailFirstLookup(env.DB);
    await phone(alice.id);
    await send(projectId, "checkout");
    await expect(drainOutbox(harness.deps)).rejects.toThrow(/notifications failed/);
    expect(harness.pushed).toEqual([]);

    await drainAll(harness);

    expect(harness.pushed.map((push) => push.title)).toEqual([TEST_SUMMARY.headline]);
    logged.mockRestore();
  });

  it("writes a summary again when the prompt has changed since", async () => {
    const { projectId, alice } = await setup();
    const harness = notifyHarness();

    await phone(alice.id);
    await send(projectId, "checkout");

    const [group] = await groupsOf(projectId);

    await new IssueSummaryStore(env.DB).put({
      groupId: group?.id ?? 0,
      promptVersion: PROMPT_VERSION - 1,
      model: "an older model",
      headline: "Old headline",
      detail: "Old detail",
      eventId: null,
      createdAt: NOW,
    });

    await drainAll(harness);

    expect(harness.pushed[0]?.title).toBe(TEST_SUMMARY.headline);
    expect(harness.prompts).toHaveLength(1);
    expect(await summaryRows()).toBe(1);
    // The stale row was replaced, not kept beside the new one.
    expect(await new IssueSummaryStore(env.DB).get(group?.id ?? 0, PROMPT_VERSION)).toEqual(
      TEST_SUMMARY,
    );
  });

  it("deletes the summary with its issue", async () => {
    const { organizationId, projectId, alice } = await setup();
    const harness = notifyHarness();

    await phone(alice.id);
    await send(projectId, "checkout");
    await drainAll(harness);
    expect(await summaryRows()).toBe(1);

    const [group] = await groupsOf(projectId);

    await new IssueStore(env.DB).delete(organizationId, group?.id ?? 0);

    expect(await summaryRows()).toBe(0);
  });

  it("summarizes only the three issues a digest lists", async () => {
    const { projectId, alice } = await setup();
    const harness = notifyHarness();

    await phone(alice.id);
    await send(projectId, "first");
    await drainAll(harness);

    for (const [offset, name] of ["second", "third", "fourth", "fifth"].entries()) {
      await send(projectId, name, NOW + (offset + 1) * MINUTE);
    }

    harness.advance(4 * MINUTE);
    await drainAll(harness);
    harness.advance(5 * MINUTE);
    await flushDigest(harness.deps, projectId);

    expect(harness.pushed[1]?.title).toMatch(/^4 issues in /);
    expect(harness.pushed[1]?.body.endsWith("\nand 1 more")).toBe(true);
    // One for the first alert, then the digest's three listed issues.
    expect(harness.prompts).toHaveLength(4);
  });

  it("sends the plain digest when any listed issue cannot be summarized", async () => {
    const { projectId, alice } = await setup();
    const harness = notifyHarness();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await phone(alice.id);
    await send(projectId, "first");
    await drainAll(harness);
    await send(projectId, "second", NOW + MINUTE);
    await send(projectId, "third", NOW + 2 * MINUTE);
    harness.advance(2 * MINUTE);
    await drainAll(harness);

    let calls = 0;

    harness.replyToSummary(() => {
      calls += 1;

      return calls === 1
        ? { ok: true, summary: TEST_SUMMARY, model: "test-model" }
        : { ok: false, error: "answer does not fit" };
    });

    harness.advance(5 * MINUTE);
    await flushDigest(harness.deps, projectId);

    expect(harness.pushed[1]?.title).toMatch(/^2 issues in /);
    expect(harness.pushed[1]?.body).toMatch(/^P\d+-[A-Z0-9]+-2 ValueError: boom\n/u);
    expect(logged.mock.calls.flat().join("\n")).toContain("push summary failed");
    logged.mockRestore();
  });
});

describe("workflow pushes", () => {
  it("does not push twice when a delivery is retried", async () => {
    const { organizationId, projectId, alice, bob } = await setup();

    await phone(bob.id);
    await bobFollowsEverything(organizationId, bob.id);
    await turnOff(bob.id, "alerts", organizationId);
    await send(projectId, "checkout");

    const harness = notifyHarness();

    await drainAll(harness);

    const [group] = await groupsOf(projectId);

    await new IssueStore(env.DB).setStatus({
      organizationId,
      issueIds: [group?.id ?? 0],
      userId: alice.id,
      status: "resolved",
      now: NOW + MINUTE,
    });

    const store = harness.deps.store;

    harness.deps.store = new CrashAfterSending(env.DB);
    await expect(drainOutbox(harness.deps)).rejects.toThrow(/notifications failed/);
    harness.deps.store = store;
    await drainAll(harness);

    expect(harness.pushed.filter((push) => push.channelId === "workflow")).toHaveLength(1);
  });

  it("never pushes to the member who made the change", async () => {
    const { organizationId, projectId, alice, bob } = await setup();

    await phone(alice.id);

    const bobPhone = await phone(bob.id);
    const harness = notifyHarness();

    await bobFollowsEverything(organizationId, bob.id);
    await turnOff(alice.id, "alerts", organizationId);
    await turnOff(bob.id, "alerts", organizationId);
    await send(projectId, "checkout");
    await drainAll(harness);

    const [group] = await groupsOf(projectId);

    await new IssueStore(env.DB).setStatus({
      organizationId,
      issueIds: [group?.id ?? 0],
      userId: alice.id,
      status: "resolved",
      now: NOW + MINUTE,
    });
    await drainAll(harness);

    expect(harness.pushed.map((push) => push.to)).toEqual([bobPhone.pushToken]);
    expect(harness.pushed[0]?.channelId).toBe("workflow");
    expect(harness.pushed[0]?.title).toContain(`${alice.email} resolved`);
    // Alerts are off for both, so only the workflow push went out: it is a
    // plain sentence and never asks the model.
    expect(harness.prompts).toEqual([]);
  });
});

describe("push receipts", () => {
  type Phone = { deviceId: number; pushToken: string };

  async function sentPush(to: Phone, ticketId: string, createdAt: number): Promise<string> {
    const pushes = new PushSendStore(env.DB);
    const key = `receipt-test:${crypto.randomUUID()}`;

    await pushes.claim(key, to, createdAt);
    await pushes.settle(key, { status: "sent", ticketId });

    return key;
  }

  async function statusOf(key: string): Promise<string | null> {
    const row = await env.DB.prepare(`SELECT status FROM push_sends WHERE key = ?1`)
      .bind(key)
      .first<{ status: string }>();

    return row?.status ?? null;
  }

  function receiptDeps(receipts: Map<string, PushReceipt>, asked: string[]): PushReceiptDeps {
    const pushes = new PushSendStore(env.DB);
    const devices = new DeviceStore(env.DB);

    return {
      awaiting: (window, cursor, limit) => pushes.awaitingReceipts(window, cursor, limit),
      receipts: async (ids) => {
        asked.push(...ids);

        return { ok: true, value: receipts };
      },
      settle: (key, outcome) => pushes.settle(key, outcome),
      expire: (before) => pushes.expireReceipts(before),
      forgetPushToken: (pushToken) => devices.forgetPushToken(pushToken),
      now: () => NOW,
    };
  }

  it("settles pushes by their receipts and drops tokens of uninstalled apps", async () => {
    const organizationId = await createOrganization(1_000_000);
    const alice = await addMember(organizationId);
    const kept = await phone(alice.id);
    const gone = await phone(alice.id);
    const devices = new DeviceStore(env.DB);

    const delivered = await sentPush(kept, "ok-ticket", NOW - 30 * MINUTE);
    const failed = await sentPush(gone, "gone-ticket", NOW - 30 * MINUTE);
    const pending = await sentPush(kept, "pending-ticket", NOW - 30 * MINUTE);
    // Too recent: Expo asks to wait 15 minutes before reading a receipt.
    const fresh = await sentPush(kept, "fresh-ticket", NOW - MINUTE);
    // Older than a day: Expo has forgotten it, so it never will be answered.
    const lost = await sentPush(kept, "lost-ticket", NOW - 2 * DAY);
    const asked: string[] = [];

    const receipts = new Map<string, PushReceipt>([
      ["ok-ticket", { status: "ok" }],
      ["gone-ticket", { status: "error", message: "gone", error: "DeviceNotRegistered" }],
    ]);

    await checkPushReceipts(receiptDeps(receipts, asked));

    expect(asked).not.toContain("fresh-ticket");
    expect(asked).not.toContain("lost-ticket");
    expect(await statusOf(delivered)).toBe("delivered");
    expect(await statusOf(failed)).toBe("failed");
    expect(await statusOf(pending)).toBe("sent");
    expect(await statusOf(fresh)).toBe("sent");
    expect(await statusOf(lost)).toBe("failed");
    expect((await devices.pushTargets([alice.id])).map((target) => target.deviceId)).toEqual([
      kept.deviceId,
    ]);
  });

  it("keeps a token the phone registered after the push the receipt is about", async () => {
    const organizationId = await createOrganization(1_000_000);
    const alice = await addMember(organizationId);
    const old = await phone(alice.id);
    const devices = new DeviceStore(env.DB);

    await sentPush(old, "old-token-ticket", NOW - 30 * MINUTE);
    // The app reinstalled, or its token rotated: the same device has a new one.
    await devices.setPushToken(old.deviceId, "ExponentPushToken[rotated]");

    const receipts = new Map<string, PushReceipt>([
      ["old-token-ticket", { status: "error", message: "gone", error: "DeviceNotRegistered" }],
    ]);

    await checkPushReceipts(receiptDeps(receipts, []));

    expect(await devices.pushTargets([alice.id])).toEqual([
      { deviceId: old.deviceId, userId: alice.id, pushToken: "ExponentPushToken[rotated]" },
    ]);
  });
});
