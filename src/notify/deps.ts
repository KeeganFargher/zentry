// What the notify consumer receives. DESIGN.md §18.

import type { DeviceStore } from "@/db/devices";
import type { MailStore } from "@/db/mail";
import type { NotifyStore } from "@/db/notify";
import type { NotificationSettingsStore } from "@/db/notify-settings";
import type { PushSendStore } from "@/db/pushes";
import type { ReportStore } from "@/db/reports";
import type { NotificationProvider } from "@/shared/contract";
import type { EventSummary, IssueNotice } from "@/shared/notify";
import type { PushMessage, PushResult, PushTicket } from "@/shared/push";

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
  devices: DeviceStore;
  pushes: PushSendStore;
  /** Sends at most SEND_BATCH pushes through Expo. Push needs no configuration, so it is always on. */
  sendPush: (messages: PushMessage[]) => Promise<PushResult<PushTicket[]>>;
  /** The issue's latest stored event, for the alert's detail; null when gone. */
  latestEvent: (issue: IssueNotice) => Promise<EventSummary | null>;
  /** Asks for a digest flush of the project after `delaySeconds`. */
  scheduleDigest: (projectId: number, delaySeconds: number) => Promise<void>;
  /** Asks for another drain, when one stopped with rows left. */
  drainAgain: () => Promise<void>;
  /**
   * Providers that asked to wait during this drain, so later rows skip them
   * (notify/providers.ts). Fresh for every queue batch.
   */
  paused: Set<NotificationProvider>;
  /** Null when email is not configured: pushes still go out, and no email does. */
  config: MailConfig | null;
  now: () => number;
};

/** Deps once email is known to be configured. */
export type MailDeps = NotifyDeps & { config: MailConfig };

/** The deps with email, or null while email is not configured. */
export function withMail(deps: NotifyDeps): MailDeps | null {
  return deps.config === null ? null : { ...deps, config: deps.config };
}
