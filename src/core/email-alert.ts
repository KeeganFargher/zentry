// The issue alert email, laid out like Sentry's: the issue, where it happened,
// then the latest event's exception, user, message and tags. DESIGN.md §18.5.
// The event is optional: without it the alert shows only the issue's fields.

import type { AlertReason, EventException, EventSummary, IssueNotice } from "@/shared/notify";

import { renderEmail } from "./email-layout";
import type { EmailBlock, EmailContent } from "./email-layout";
import { clip, count, formatUtc, issueSubject, issueUrl, settingsUrl } from "./email-messages";
import type { MailLinks } from "./email-messages";

/** Frames shown per exception, innermost last, as Sentry shows them. */
const MAX_FRAMES = 12;
const MAX_EXCEPTIONS = 3;
const MAX_TAGS = 40;

/** An exception value can be a whole HTML error page; this keeps the email small. */
const MAX_VALUE = 2000;
const MAX_DETAIL = 200;

const FULL_TIME = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

export type AlertNotice = { issue: IssueNotice; reason: AlertReason; event: EventSummary | null };

function frameLines(exception: EventException): string[] {
  const inApp = exception.frames.filter((frame) => frame.inApp);
  const frames = (inApp.length > 0 ? inApp : exception.frames).slice(-MAX_FRAMES);

  return frames.flatMap((frame) => {
    const where = [
      `  File "${frame.filename ?? "?"}"`,
      ...(frame.lineno === null ? [] : [`line ${frame.lineno}`]),
      `in ${frame.function ?? "?"}`,
    ].join(", ");

    return frame.contextLine === null ? [where] : [where, `    ${frame.contextLine.trim()}`];
  });
}

function exceptionText(exceptions: EventException[]): string {
  return exceptions
    .slice(-MAX_EXCEPTIONS)
    .map((exception) => {
      const head = [
        exception.type,
        exception.value === null ? null : clip(exception.value, MAX_VALUE),
      ]
        .filter((part) => part !== null)
        .join(": ");

      return [head, ...frameLines(exception)].join("\n");
    })
    .join("\n\n");
}

function userRows(event: EventSummary): [string, string][] {
  const { user } = event;

  if (user === null) {
    return [];
  }

  const rows: [string, string | null][] = [
    ["ID", user.id],
    ["Email", user.email],
    ["Username", user.username],
    ["IP Address", user.ipAddress],
  ];

  return rows.flatMap(([label, value]): [string, string][] =>
    value === null ? [] : [[label, value]],
  );
}

function factRows(notice: AlertNotice): [string, string][] {
  const { issue, event } = notice;
  const rows: [string, string][] = [["Project", issue.project.slug]];

  if (event !== null && event.environment !== "") {
    rows.push(["Environment", event.environment]);
  }

  rows.push(["Level", issue.level]);

  if (event !== null && event.release !== null) {
    rows.push(["Release", event.release]);
  }

  if (issue.culprit !== "") {
    rows.push(["Culprit", issue.culprit]);
  }

  rows.push(["Events", count(issue.timesSeen)], ["First seen", formatUtc(issue.firstSeen)]);

  return rows;
}

type Headline = { title: string; detail: string | null };

/** The card's title and the line under it: the innermost exception, which names the issue. */
function issueHeadline(notice: AlertNotice): Headline {
  const { issue, event } = notice;
  const exception = event?.exceptions.at(-1) ?? null;
  const title = exception?.type ?? issue.title;
  const value = exception === null ? issue.message : exception.value;

  if (value !== null && value !== title) {
    return { title, detail: clip(value, MAX_DETAIL) };
  }

  return { title, detail: issue.culprit === "" ? null : issue.culprit };
}

function issueBlock(notice: AlertNotice, url: string): EmailBlock {
  const { issue, event } = notice;

  const meta =
    event === null
      ? [`${FULL_TIME.format(issue.lastSeen)} UTC`]
      : [`${FULL_TIME.format(event.timestamp)} UTC`, `ID: ${event.eventId}`];

  return { kind: "issue", ...issueHeadline(notice), url, meta };
}

/** The event's own sections, each only when it has something to show. */
function eventBlocks(notice: AlertNotice): EmailBlock[] {
  const { issue, event } = notice;

  if (event === null) {
    return issue.message === null || issue.title.includes(issue.message)
      ? []
      : [
          { kind: "section", text: "Message" },
          { kind: "code", text: clip(issue.message, MAX_VALUE) },
        ];
  }

  const blocks: EmailBlock[] = [];
  const user = userRows(event);

  if (event.exceptions.length > 0) {
    blocks.push(
      { kind: "section", text: "Exception" },
      { kind: "code", text: exceptionText(event.exceptions) },
    );
  }

  if (user.length > 0) {
    blocks.push({ kind: "section", text: "User" }, { kind: "facts", rows: user });
  }

  if (event.message !== null) {
    blocks.push(
      { kind: "section", text: "Message" },
      { kind: "code", text: clip(event.message, MAX_VALUE) },
    );
  }

  if (event.tags.length > 0) {
    blocks.push(
      { kind: "section", text: "Tags" },
      { kind: "tags", pairs: event.tags.slice(0, MAX_TAGS) },
    );
  }

  return blocks;
}

export function alertEmail(notice: AlertNotice, links: MailLinks): EmailContent {
  const { issue, reason } = notice;
  const url = issueUrl(links.appUrl, issue, "alert_email");
  const project = issue.project.slug;

  return renderEmail({
    subject: issueSubject(issue),
    action: { label: "View on Zentry", url },
    blocks: [
      { kind: "heading", text: reason === "new_issue" ? "New issue" : "Regressed issue" },
      {
        kind: "note",
        text:
          reason === "new_issue"
            ? `A new issue was first seen in ${project}.`
            : `An issue in ${project} that was resolved has happened again.`,
      },
      { kind: "label", text: "Issue" },
      issueBlock(notice, url),
      { kind: "facts", rows: factRows(notice) },
      ...eventBlocks(notice),
    ],
    footer: {
      reason: `You get this because issue alerts are on for ${project}.`,
      settingsUrl: settingsUrl(links.appUrl, issue.project.organization),
      unsubscribeUrl: links.unsubscribeUrl,
    },
  });
}
