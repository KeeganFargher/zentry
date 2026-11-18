// The text of every notification email but the alert (email-alert.ts).
// DESIGN.md §18.5. Subjects follow Sentry's: "API-12 - TypeError: ..." for anything about an issue,
// so alerts and workflow emails about one issue share a subject and thread.

import type { IssueStatus } from "@/shared/contract";
import type {
  AlertReason,
  IssueNotice,
  OrganizationNotice,
  ProjectNotice,
  WeeklyReport,
} from "@/shared/notify";

import { renderEmail } from "./email-layout";
import type { EmailBlock, EmailContent } from "./email-layout";

/** Where links point, and this email's unsubscribe link if it has one. */
export type MailLinks = { appUrl: string; unsubscribeUrl: string | null };

const PREFIX = "[Zentry]";
const MAX_SUBJECT_TITLE = 200;
const DIGEST_SHOWN = 10;

const DATE_TIME = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const DATE = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" });

const MONTH = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", year: "numeric" });

/** Times are UTC: Zentry stores no timezone for its users yet. */
export function formatUtc(ms: number): string {
  return `${DATE_TIME.format(ms)} UTC`;
}

export function count(value: number): string {
  return value.toLocaleString("en-US");
}

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function settingsUrl(appUrl: string, organization: OrganizationNotice): string {
  return `${appUrl}/${organization.slug}/settings/notifications/`;
}

export function issueUrl(appUrl: string, issue: IssueNotice, referrer: string): string {
  return `${appUrl}/${issue.project.organization.slug}/issues/${issue.id}/?referrer=${referrer}`;
}

/** No "[Zentry]" prefix: Sentry dropped its own, and the short id says where it is from. */
export function issueSubject(issue: IssueNotice): string {
  return `${issue.shortId} - ${clip(issue.title, MAX_SUBJECT_TITLE)}`;
}

export function issueFacts(issue: IssueNotice): EmailBlock {
  const rows: [string, string][] = [
    ["Project", issue.project.slug],
    ["Level", issue.level],
  ];

  if (issue.culprit !== "") {
    rows.push(["Culprit", issue.culprit]);
  }

  rows.push(["Events", count(issue.timesSeen)], ["First seen", formatUtc(issue.firstSeen)]);

  return { kind: "facts", rows };
}

export type DigestItem = { issue: IssueNotice; reason: AlertReason };

/** The alerts a project's digest window held, since its last send. */
export type DigestNotice = { project: ProjectNotice; items: DigestItem[]; since: number };

export function digestEmail(digest: DigestNotice, links: MailLinks): EmailContent {
  const { project, items, since } = digest;
  const shown = items.slice(0, DIGEST_SHOWN);
  const more = items.length - shown.length;

  const list: EmailBlock = {
    kind: "links",
    items: shown.map(({ issue, reason }) => ({
      label: `${issue.shortId} ${clip(issue.title, 120)}`,
      url: issueUrl(links.appUrl, issue, "digest_email"),
      detail: `${reason === "new_issue" ? "New" : "Regressed"} · ${count(issue.timesSeen)} events`,
    })),
  };

  const issues = `${links.appUrl}/${project.organization.slug}/issues/?project=${project.id}`;

  return renderEmail({
    subject: `${PREFIX} ${project.slug} - ${items.length} new alerts since ${formatUtc(since)}`,
    blocks: [
      { kind: "heading", text: `${items.length} issues alerted in ${project.slug}` },
      list,
      ...(more > 0 ? [{ kind: "paragraph" as const, text: `And ${more} more.` }] : []),
      { kind: "button", label: "View issues", url: issues },
    ],
    footer: {
      reason: `You get this because issue alerts are on for ${project.slug}. Alerts close together are sent as one email.`,
      settingsUrl: settingsUrl(links.appUrl, project.organization),
      unsubscribeUrl: links.unsubscribeUrl,
    },
  });
}

const VERBS = { resolved: "resolved", ignored: "archived", unresolved: "reopened" } satisfies {
  [status in IssueStatus]: string;
};

export function workflowEmail(
  issue: IssueNotice,
  change: { actor: string; status: IssueStatus },
  links: MailLinks,
): EmailContent {
  return renderEmail({
    subject: issueSubject(issue),
    blocks: [
      { kind: "heading", text: `${change.actor} ${VERBS[change.status]} ${issue.shortId}` },
      { kind: "paragraph", text: issue.title },
      issueFacts(issue),
      {
        kind: "button",
        label: "View on Zentry",
        url: issueUrl(links.appUrl, issue, "activity_email"),
      },
    ],
    footer: {
      reason: "You get this because you follow this issue, or get workflow emails for all issues.",
      settingsUrl: settingsUrl(links.appUrl, issue.project.organization),
      unsubscribeUrl: links.unsubscribeUrl,
    },
  });
}

export type QuotaNotice = {
  organization: OrganizationNotice;
  percent: number;
  limit: number;
  month: number;
  nextMonth: number;
};

export function quotaEmail(notice: QuotaNotice, links: MailLinks): EmailContent {
  const { organization, percent, limit } = notice;
  const full = percent >= 100;

  const text = full
    ? `${organization.name} has sent its ${count(limit)} events for ${MONTH.format(notice.month)}. Zentry refuses every event until ${DATE.format(notice.nextMonth)} (UTC). Raise the monthly cap to accept them again.`
    : `${organization.name} has used ${percent}% of its ${count(limit)} events for ${MONTH.format(notice.month)}. At 100%, every event is refused until the month ends.`;

  return renderEmail({
    subject: `${PREFIX} ${organization.name} has used ${percent}% of its monthly events`,
    blocks: [
      {
        kind: "heading",
        text: full ? "Monthly event cap reached" : `${percent}% of the monthly cap used`,
      },
      { kind: "paragraph", text },
      {
        kind: "button",
        label: "Spend limits",
        url: `${links.appUrl}/${organization.slug}/settings/`,
      },
    ],
    footer: {
      reason: `You get this because quota emails are on for ${organization.name}.`,
      settingsUrl: settingsUrl(links.appUrl, organization),
      unsubscribeUrl: links.unsubscribeUrl,
    },
  });
}

export type SpikeNotice = { project: ProjectNotice; limit: number; until: number };

export function spikeEmail(notice: SpikeNotice, links: MailLinks): EmailContent {
  const { project } = notice;
  const settings = `${links.appUrl}/${project.organization.slug}/settings/projects/${project.slug}/`;

  return renderEmail({
    subject: `${PREFIX} Spike protection is refusing events for ${project.slug}`,
    blocks: [
      { kind: "heading", text: `Spike protection activated for ${project.slug}` },
      {
        kind: "paragraph",
        text: `${project.slug} sent more than ${count(notice.limit)} events this hour, far above its usual rate. Zentry refuses its events until ${formatUtc(notice.until)}, then accepts them again. If bursts like this are expected, turn spike protection off in the project's settings.`,
      },
      { kind: "button", label: "Project settings", url: settings },
    ],
    footer: {
      reason: `You get this because spike protection emails are on for ${project.slug}.`,
      settingsUrl: settingsUrl(links.appUrl, project.organization),
      unsubscribeUrl: links.unsubscribeUrl,
    },
  });
}

export function weeklyReportEmail(report: WeeklyReport, links: MailLinks): EmailContent {
  const { organization, totals } = report;
  const range = `${DATE.format(report.start)} - ${DATE.format(report.end - 1)}`;
  const base = `${links.appUrl}/${organization.slug}/issues/`;

  const top: EmailBlock = {
    kind: "links",
    items: report.top.map((issue) => ({
      label: `${issue.shortId} ${clip(issue.title, 120)}`,
      url: `${base}${issue.id}/?referrer=weekly_report`,
      detail: `${count(issue.events)} events this week`,
    })),
  };

  return renderEmail({
    subject: `${PREFIX} Weekly Report for ${organization.name}: ${range}`,
    blocks: [
      { kind: "heading", text: `${organization.name}, ${range} (UTC)` },
      {
        kind: "facts",
        rows: [
          ["Errors", count(totals.events)],
          ["New issues", count(totals.newIssues)],
          ["Regressed", count(totals.regressed)],
          ["Resolved", count(totals.resolved)],
        ],
      },
      {
        kind: "facts",
        rows: report.projects.map((row) => [
          row.slug,
          `${count(row.events)} errors, ${count(row.newIssues)} new issues`,
        ]),
      },
      ...(report.top.length > 0
        ? [{ kind: "heading" as const, text: "Most frequent issues" }, top]
        : []),
      { kind: "button", label: "View issues", url: `${base}?referrer=weekly_report` },
    ],
    footer: {
      reason: `You get this weekly because reports are on for ${organization.name}.`,
      settingsUrl: settingsUrl(links.appUrl, organization),
      unsubscribeUrl: links.unsubscribeUrl,
    },
  });
}
