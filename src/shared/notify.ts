// What the notify consumer reads from D1 and hands to the email builders.
// DESIGN.md §18. Shared because db/ produces these and core/ renders them.

import type { IssueStatus, Level, NotificationType, Pair } from "./contract";
import type { MonitorChannelName, MonitorTriggerName, NewMonitorRule } from "./monitor-alerts";

export type MonitorDelivery = {
  id: number;
  groupId: number;
  ruleId: string;
  channel: MonitorChannelName;
  transition: MonitorTriggerName;
  monitorId: string;
  ownerId: number | null;
  environment: string;
  periodId: number | null;
  belowCount: number;
  audience: NewMonitorRule["audience"];
};

export type AlertReason = "new_issue" | "regression";

/** One row of the outbox, as the notify consumer handles it. */
export type OutboxItem =
  | { id: number; kind: "monitor"; transitionId: number }
  | { id: number; kind: AlertReason; groupId: number }
  | { id: number; kind: "status"; groupId: number; actorId: number | null; status: IssueStatus }
  | {
      id: number;
      kind: "quota";
      organizationId: number;
      percent: number;
      month: number;
      limit: number;
    }
  | { id: number; kind: "spike"; projectId: number; until: number; limit: number }
  | { id: number; kind: "weekly_report"; organizationId: number; start: number; end: number };

export type OrganizationNotice = { id: number; slug: string; name: string };

export type ProjectNotice = {
  id: number;
  slug: string;
  name: string;
  organization: OrganizationNotice;
};

export type IssueNotice = {
  id: number;
  shortId: string;
  title: string;
  culprit: string;
  level: Level;
  /** The exception value or log message, when there is one. */
  message: string | null;
  status: IssueStatus;
  timesSeen: number;
  firstSeen: number;
  lastSeen: number;
  /** The latest stored event, which an alert shows; null before one is stored. */
  lastEventId: string | null;
  project: ProjectNotice;
};

export type EventFrame = {
  filename: string | null;
  function: string | null;
  lineno: number | null;
  colno: number | null;
  inApp: boolean;
  contextLine: string | null;
};

export type EventException = { type: string | null; value: string | null; frames: EventFrame[] };

export type EventUser = {
  id: string | null;
  email: string | null;
  username: string | null;
  ipAddress: string | null;
};

/** What an alert email shows of an issue's latest event, read back from R2. */
export type EventSummary = {
  eventId: string;
  timestamp: number;
  environment: string;
  release: string | null;
  message: string | null;
  exceptions: EventException[];
  tags: Pair[];
  user: EventUser | null;
};

export type Recipient = { userId: number; email: string };

/** One email the mailer is asked to send. */
export type OutgoingEmail = {
  /** Unique per email and recipient; a second send with the same key is skipped. */
  key: string;
  kind: NotificationType;
  recipient: Recipient;
  /** The issue it is about, for threading; null for account-wide emails. */
  groupId: number | null;
  subject: string;
  text: string;
  html: string;
  unsubscribeUrl: string | null;
};

export type WeeklyTotals = {
  events: number;
  newIssues: number;
  regressed: number;
  resolved: number;
};

export type WeeklyProject = { slug: string; events: number; newIssues: number };

export type WeeklyIssue = {
  id: number;
  shortId: string;
  title: string;
  culprit: string;
  events: number;
};

export type WeeklyReport = {
  organization: OrganizationNotice;
  start: number;
  end: number;
  totals: WeeklyTotals;
  projects: WeeklyProject[];
  top: WeeklyIssue[];
};
