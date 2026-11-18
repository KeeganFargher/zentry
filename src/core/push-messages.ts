// The text of every push notification. DESIGN.md §19. A push is read on a
// lock screen in a line or two, so each says what happened and where; the
// detail is one tap away in the app, which `data` opens.

import type { IssueStatus } from "@/shared/contract";
import type { AlertReason, IssueNotice } from "@/shared/notify";
import type { PushContent } from "@/shared/push";

import { clip, count, formatUtc } from "./email-messages";
import type { DigestItem, QuotaNotice, SpikeNotice } from "./email-messages";

// Android shows about this much of a body before "…"; the rest only costs bytes
// of the 4 KiB payload Expo allows.
const MAX_BODY = 240;
const DIGEST_LISTED = 3;

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
