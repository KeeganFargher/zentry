// Copied from ui/src/lib/issue.ts, so the app words an issue as the web UI does.
// Wording derived from an issue's state, shared by the list and the issue page.

import type { ApiIssue } from "@contract";

const WEEK = 7 * 24 * 60 * 60 * 1000;

const CLOSED = new Map([
  ["resolved", "Resolved"],
  ["ignored", "Archived"],
]);

/** Sentry's word for where an issue is in its life: New, Ongoing, Regressed, Resolved, Archived. */
export function substatus(issue: ApiIssue, now: number): string {
  if (issue.status !== "unresolved") {
    return CLOSED.get(issue.status) ?? issue.status;
  }

  if (issue.substatus === "regressed") {
    return "Regressed";
  }

  return now - issue.firstSeen < WEEK ? "New" : "Ongoing";
}

/** The bold first line: the exception type, or the message for message events. */
export function issueTitle(issue: ApiIssue): string {
  return issue.metadata.type ?? issue.title;
}

/** The second line: the exception value, or where a message event came from. */
export function issueMessage(issue: ApiIssue): string | null {
  const text = issue.metadata.type === null ? issue.culprit : issue.metadata.value;

  return text === null || text === "" ? null : text;
}

export function levelLabel(level: string): string {
  return `${level.slice(0, 1).toUpperCase()}${level.slice(1)}`;
}
