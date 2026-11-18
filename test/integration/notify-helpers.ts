import { env } from "cloudflare:workers";

import { EventBlobs } from "@/blobs/events";
import { MailStore } from "@/db/mail";
import { NotifyStore } from "@/db/notify";
import { NotificationSettingsStore } from "@/db/notify-settings";
import { ReportStore } from "@/db/reports";
import type { MailMessage, NotifyDeps } from "@/notify/deps";

import { NOW } from "./helpers";

export type Sent = MailMessage;

export type Harness = {
  deps: NotifyDeps;
  sent: Sent[];
  scheduled: { projectId: number; delaySeconds: number }[];
  drains: number;
  /** Moves the clock the notify consumer sees. */
  advance: (ms: number) => void;
};

/** Notify deps over the real D1, with a fake sender and a movable clock. */
export function notifyHarness(fail: (to: string) => Error | null = () => null): Harness {
  let clock = NOW;
  let sequence = 0;

  const harness: Harness = {
    sent: [],
    scheduled: [],
    drains: 0,
    advance: (ms) => {
      clock += ms;
    },
    deps: {
      store: new NotifyStore(env.DB),
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
      latestEvent: async (issue) =>
        issue.lastEventId === null
          ? null
          : new EventBlobs(env.BLOBS).summary(issue.project.id, issue.lastEventId),
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
