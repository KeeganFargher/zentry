import { env } from "cloudflare:workers";

import { EventBlobs } from "@/blobs/events";
import { DeviceStore } from "@/db/devices";
import { IssueSummaryStore } from "@/db/issue-summaries";
import { MailStore } from "@/db/mail";
import { NotifyStore } from "@/db/notify";
import { NotificationSettingsStore } from "@/db/notify-settings";
import { PushSendStore } from "@/db/pushes";
import { ReportStore } from "@/db/reports";
import type { MailMessage, NotifyDeps } from "@/notify/deps";
import type { SummaryPrompt, SummaryResult } from "@/shared/notify";
import type { PushMessage, PushResult, PushTicket } from "@/shared/push";

import { NOW } from "./helpers";

export type Sent = MailMessage;

/** What the fake Expo answers for one batch; by default every push is accepted. */
export type PushReply = (messages: PushMessage[]) => PushResult<PushTicket[]>;

const acceptAll: PushReply = (messages) => ({
  ok: true,
  value: messages.map((_, index) => ({ status: "ok", id: `ticket-${index}` })),
});

/** What the fake Workers AI answers; by default the same summary for every issue. */
export type SummaryReply = (prompt: SummaryPrompt) => SummaryResult;

export const TEST_SUMMARY = {
  headline: "Checkout is failing",
  detail: "Your checkout handler raised an error with no cause given.",
};

const summarizeAll: SummaryReply = () => ({ ok: true, summary: TEST_SUMMARY, model: "test-model" });

export type Harness = {
  deps: NotifyDeps;
  sent: Sent[];
  pushed: PushMessage[];
  /** Replaces how the fake Expo answers. */
  replyToPush: (reply: PushReply) => void;
  /** Every prompt the fake Workers AI was sent. */
  prompts: SummaryPrompt[];
  /** Replaces how the fake Workers AI answers. */
  replyToSummary: (reply: SummaryReply) => void;
  scheduled: { projectId: number; delaySeconds: number }[];
  drains: number;
  /** Moves the clock the notify consumer sees. */
  advance: (ms: number) => void;
};

/** Notify deps over the real D1, with a fake sender and a movable clock. */
export function notifyHarness(fail: (to: string) => Error | null = () => null): Harness {
  let clock = NOW;
  let sequence = 0;
  let pushReply = acceptAll;
  let summaryReply = summarizeAll;

  const harness: Harness = {
    sent: [],
    pushed: [],
    replyToPush: (reply) => {
      pushReply = reply;
    },
    prompts: [],
    replyToSummary: (reply) => {
      summaryReply = reply;
    },
    scheduled: [],
    drains: 0,
    advance: (ms) => {
      clock += ms;
    },
    deps: {
      store: new NotifyStore(env.DB),
      monitorAlertsPaused: false,
      monitorBelowCountPaging: false,
      settings: new NotificationSettingsStore(env.DB),
      mail: new MailStore(env.DB),
      reports: new ReportStore(env.DB),
      send: async (message) => {
        const { to } = message;
        const error = fail(to);

        if (error !== null) {
          throw error;
        }

        sequence += 1;
        harness.sent.push(message);

        return { messageId: `m${sequence}@zentry.test` };
      },
      devices: new DeviceStore(env.DB),
      pushes: new PushSendStore(env.DB),
      paused: new Set(),
      sendPush: async (messages) => {
        const reply = pushReply(messages);

        if (reply.ok) {
          harness.pushed.push(...messages);
        }

        return reply;
      },
      latestEvent: async (issue) =>
        issue.lastEventId === null
          ? null
          : new EventBlobs(env.BLOBS).summary(issue.project.id, issue.lastEventId),
      summarize: async (prompt) => {
        harness.prompts.push(prompt);

        return summaryReply(prompt);
      },
      summaries: new IssueSummaryStore(env.DB),
      scheduleDigest: async (projectId, delaySeconds) => {
        harness.scheduled.push({ projectId, delaySeconds });
      },
      drainAgain: async () => {
        harness.drains += 1;
      },
      config: {
        from: "Zentry <alerts@zentry.test>",
        appUrl: "https://zentry.test",
        unsubscribeUrl: "https://ingest.zentry.test/notifications/unsubscribe",
        signingKey: "test-signing-key",
      },
      now: () => clock,
    },
  };

  return harness;
}

let users = 0;

/** A user who is a member of the organization. */
export async function addMember(organizationId: number): Promise<{ id: number; email: string }> {
  users += 1;

  const email = `member${users}-${crypto.randomUUID().slice(0, 8)}@example.com`;

  const row = await env.DB.prepare(
    `INSERT INTO users (email, created_at, last_seen_at) VALUES (?1, ?2, ?2) RETURNING id`,
  )
    .bind(email, NOW)
    .first<{ id: number }>();

  if (row === null) {
    throw new Error("user was not created");
  }

  await env.DB.prepare(
    `INSERT INTO organization_members (organization_id, user_id, role, created_at)
     VALUES (?1, ?2, 'member', ?3)`,
  )
    .bind(organizationId, row.id, NOW)
    .run();

  return { id: row.id, email };
}

export function errorWithCode(code: string): Error {
  return Object.assign(new Error(`failed: ${code}`), { code });
}

export async function outboxKinds(): Promise<string[]> {
  const { results } = await env.DB.prepare(`SELECT kind FROM notify_outbox ORDER BY id`).all<{
    kind: string;
  }>();

  return results.map((row) => row.kind);
}
