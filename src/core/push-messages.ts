// The text of every push notification. DESIGN.md §19. A push is read on a
// lock screen in a line or two, so each says what happened and where; the
// detail is one tap away in the app, which `data` opens.

import type { IssueStatus } from "@/shared/contract";
import type { AlertReason, IssueNotice, IssueSummary } from "@/shared/notify";
import type { PushContent } from "@/shared/push";

import { clip, count, formatUtc } from "./email-messages";
import type { DigestItem, QuotaNotice, SpikeNotice } from "./email-messages";

// Android shows about this much of a body before "…"; the rest only costs bytes
// of the 4 KiB payload Expo allows.
const MAX_BODY = 240;

/** A digest push lists this many issues; the rest are counted. */
export const DIGEST_LISTED = 3;

const ALERT_TITLES = { new_issue: "New issue", regression: "Regression" } satisfies {
  [reason in AlertReason]: string;
};

const VERBS = { resolved: "resolved", ignored: "archived", unresolved: "reopened" } satisfies {
  [status in IssueStatus]: string;
};

function issueData(issue: IssueNotice): PushContent["data"] {
  return { kind: "issue", organization: issue.project.organization.slug, issueId: issue.id };
}

/** The title, then the culprit when there is one: what a stack trace would show first. */
function issueBody(issue: IssueNotice): string {
  return clip(issue.culprit === "" ? issue.title : `${issue.title}\n${issue.culprit}`, MAX_BODY);
}

/**
 * An alert with the summary Workers AI wrote (DESIGN.md §19.2), and the
 * environment of the latest event: empty when it is unknown, as on
 * EventSummary.
 */
export type SummarizedItem = DigestItem & { summary: IssueSummary; environment: string };

/** One issue of a summarized digest. */
export type DigestLine = { issue: IssueNotice; summary: IssueSummary };

const COMPACT = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

/** 1.3K, 12.3K, 1.3M: a count that fits a lock screen line. */
export function compactCount(value: number): string {
  return COMPACT.format(value);
}

/**
 * Zentry's own facts under the model's text. Nothing here comes from the
 * model, so a crafted error cannot dress itself up as Zentry's judgement. The
 * short id already names the project. The count only says something on a
 * regression: a new issue has been seen about once.
 */
function factsLine(item: SummarizedItem): string {
  const { issue } = item;

  return [
    issue.shortId,
    ...(item.environment === "" ? [] : [item.environment]),
    ...(item.reason === "regression" ? [`${compactCount(issue.timesSeen)} events`] : []),
  ].join(" · ");
}

/** The model's headline and detail, then the facts line. */
export function summaryPush(item: SummarizedItem): PushContent {
  const { headline, detail } = item.summary;

  return {
    channel: "alerts",
    title: item.reason === "regression" ? `Back again: ${headline}` : headline,
    body: clip(`${detail}\n${factsLine(item)}`, MAX_BODY),
    data: issueData(item.issue),
  };
}

/** A digest listing each issue's headline instead of its title. */
export function summaryDigestPush(items: DigestLine[], total: number): PushContent {
  const [first] = items;

  if (first === undefined) {
    throw new Error("a digest push needs at least one issue");
  }

  const { project } = first.issue;
  const listed = items.map((item) => `${item.issue.shortId} ${item.summary.headline}`);
  const more = total - listed.length;

  return {
    channel: "alerts",
    title: `${count(total)} issues in ${project.slug}`,
    body: clip([...listed, ...(more > 0 ? [`and ${count(more)} more`] : [])].join("\n"), MAX_BODY),
    data: { kind: "issues", organization: project.organization.slug, projectId: project.id },
  };
}

/** Today's alert, from the issue's own title: sent when no summary could be written. */
export function alertPush(issue: IssueNotice, reason: AlertReason): PushContent {
  return {
    channel: "alerts",
    title: `${ALERT_TITLES[reason]} in ${issue.project.slug} · ${issue.shortId}`,
    body: issueBody(issue),
    data: issueData(issue),
  };
}

/** Several alerts of one project, held by its digest window, as one push. */
export function digestPush(items: DigestItem[]): PushContent {
  const [first] = items;

  if (first === undefined) {
    throw new Error("a digest push needs at least one issue");
  }

  const { project } = first.issue;

  const listed = items
    .slice(0, DIGEST_LISTED)
    .map((item) => `${item.issue.shortId} ${item.issue.title}`);

  const more = items.length - listed.length;

  return {
    channel: "alerts",
    title: `${count(items.length)} issues in ${project.slug}`,
    body: clip([...listed, ...(more > 0 ? [`and ${count(more)} more`] : [])].join("\n"), MAX_BODY),
    data: { kind: "issues", organization: project.organization.slug, projectId: project.id },
  };
}

export function workflowPush(
  issue: IssueNotice,
  change: { actor: string; status: IssueStatus },
): PushContent {
  return {
    channel: "workflow",
    title: `${change.actor} ${VERBS[change.status]} ${issue.shortId}`,
    body: clip(issue.title, MAX_BODY),
    data: issueData(issue),
  };
}

export function quotaPush(notice: QuotaNotice): PushContent {
  const { organization, percent, limit } = notice;

  return {
    channel: "quota",
    title: percent >= 100 ? "Monthly event cap reached" : `${percent}% of the monthly cap used`,
    body:
      percent >= 100
        ? `${organization.name} is refusing every event until the month ends (${count(limit)} cap).`
        : `${organization.name} has used ${percent}% of its ${count(limit)} events this month.`,
    data: { kind: "settings", organization: organization.slug },
  };
}

export function spikePush(notice: SpikeNotice): PushContent {
  const { project } = notice;

  return {
    channel: "spikeProtection",
    title: `Spike protection on for ${project.slug}`,
    body: `More than ${count(notice.limit)} events this hour. Refusing events until ${formatUtc(notice.until)}.`,
    data: { kind: "issues", organization: project.organization.slug, projectId: project.id },
  };
}
