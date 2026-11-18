// What the notify consumer receives. DESIGN.md §18.

import type { MailStore } from "@/db/mail";
import type { NotifyStore } from "@/db/notify";
import type { NotificationSettingsStore } from "@/db/notify-settings";
import type { ReportStore } from "@/db/reports";
import type { EventSummary, IssueNotice } from "@/shared/notify";

export type MailConfig = {
  /** The sender, such as "Zentry <alerts@zentry.example.com>". */
  from: string;
  /** The UI's origin, for links in emails. */
  appUrl: string;
  /** The unsubscribe endpoint on the ingest host, which Access does not guard. */
  unsubscribeUrl: string;
  /** Signs unsubscribe links. */
  signingKey: string;
};

/** One email to one address: the only shape the mailer sends. */
export type MailMessage = EmailReplyMessageBuilder & { to: string };

export type NotifyDeps = {
  store: NotifyStore;
  settings: NotificationSettingsStore;
  mail: MailStore;
  reports: ReportStore;
  send: (message: MailMessage) => Promise<EmailSendResult>;
  /** The issue's latest stored event, for the alert's detail; null when gone. */
  latestEvent: (issue: IssueNotice) => Promise<EventSummary | null>;
  /** Asks for a digest flush of the project after `delaySeconds`. */
  scheduleDigest: (projectId: number, delaySeconds: number) => Promise<void>;
  /** Asks for another drain, when one stopped with rows left. */
  drainAgain: () => Promise<void>;
  /** Null when email is not configured: the outbox is drained and nothing is sent. */
  config: MailConfig | null;
  now: () => number;
};

/** Deps once email is known to be configured. */
export type MailDeps = NotifyDeps & { config: MailConfig };
