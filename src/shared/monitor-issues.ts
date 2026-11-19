// The issue lifecycle's types, shared by its pure rules (src/core/monitor-issues.ts)
// and the batch that writes them (src/db/monitor-issues.ts).

export type IssueStatus = "unresolved" | "resolved" | "ignored";

/** The parts of a monitor's issue that decide its next state. */
export type MonitorIssue = { status: IssueStatus; level: string; timesSeen: number };

export type IssueState = { issue: MonitorIssue | null; periodOpen: boolean };

/**
 * An observation as the lifecycle reads it. `sighted` is false for a success
 * that has not yet met the recovery streak: the scope is still failing, but
 * nothing failed just now, so the issue is not seen again.
 */
export type Signal = {
  health: "healthy" | "failing";
  severity: "medium" | "high" | null;
  sighted: boolean;
  at: number;
};

export type TransitionType = "failure" | "escalation" | "recovery";

export type Transition = { type: TransitionType; severity: "medium" | "high" };

/** What the failing observation writes to the issue row. */
export type Reopen = {
  kind: "failing";
  level: "error" | "warning";
  // A resolved issue becomes "regressed"; otherwise the substatus stays.
  regressed: boolean;
  sighted: boolean;
};

export type Resolve = { kind: "healthy" };

/**
 * The writes one observation makes, in the order they must run: the period
 * opens before a failure's transition so the transition can name it, and a
 * recovery's transition is written before the period it ends is closed.
 */
export type IssueChange = {
  createIssue: { level: "error" | "warning" } | null;
  activity: "resolved" | "regressed" | null;
  openPeriod: boolean;
  transition: Transition | null;
  closePeriod: boolean;
  update: Reopen | Resolve | null;
};

/**
 * The scope's issue state as read, and the writes for each observation in a
 * batch, aligned with the observations; null where one changes nothing.
 */
export type IssuePlan = { state: IssueState; changes: (IssueChange | null)[] };

export const NO_ISSUE: IssueState = { issue: null, periodOpen: false };
