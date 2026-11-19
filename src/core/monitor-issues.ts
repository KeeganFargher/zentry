// A monitor scope's issue lifecycle: how one observation changes the scope's
// issue, its incident period, and whether it is a transition alerts hear about.
// Pure, so the writers fold a batch of observations in order and write the
// result in one fenced batch (src/db/monitor-issues.ts).

import type { CronWrite, PlannedCronWrite } from "@/shared/cron";
import type {
  IssueChange,
  IssuePlan,
  IssueState,
  MonitorIssue,
  Signal,
  Transition,
} from "@/shared/monitor-issues";

/** One observation applied: the scope's next state and the writes that get it there. */
export type Step = { next: IssueState; change: IssueChange | null };

function levelOf(severity: Signal["severity"]): "error" | "warning" {
  return severity === "medium" ? "warning" : "error";
}

function severityOf(level: string): Transition["severity"] {
  return level === "warning" ? "medium" : "high";
}

/**
 * A failing observation opens the scope's issue or reopens it, and opens an
 * incident period. It alerts when the issue (re)opens, is first seen, or rises
 * from medium to high; a repeat at the same level is not news.
 */
/**
 * A failing observation alerts when the issue (re)opens, is first seen, or
 * rises from medium to high; a repeat at the same level is not news. An issue
 * already seen that stays open is escalating; anything else is a new failure.
 */
function transitionFor(
  before: MonitorIssue,
  level: "error" | "warning",
  timesSeen: number,
): Transition | null {
  const reopened = before.status !== "unresolved";
  const escalated = level === "error" && before.level === "warning";
  const firstSeen = before.timesSeen === 0 && timesSeen === 1;

  if (!reopened && !escalated && !firstSeen) {
    return null;
  }

  return {
    type: before.timesSeen > 0 && !reopened ? "escalation" : "failure",
    severity: severityOf(level),
  };
}

/** A failing observation opens the scope's issue or reopens it, and opens an incident period. */
function failing(state: IssueState, signal: Signal): Step {
  const level = levelOf(signal.severity);
  const before = state.issue ?? { status: "unresolved", level, timesSeen: 0 };
  const timesSeen = before.timesSeen + (signal.sighted ? 1 : 0);
  const regressed = before.status === "resolved";

  return {
    next: { issue: { status: "unresolved", level, timesSeen }, periodOpen: true },
    change: {
      createIssue: state.issue === null ? { level } : null,
      activity: regressed ? "regressed" : null,
      openPeriod: !state.periodOpen,
      transition: transitionFor(before, level, timesSeen),
      closePeriod: false,
      update: { kind: "failing", level, regressed, sighted: signal.sighted },
    },
  };
}

/**
 * A healthy observation ends the open period and resolves an open issue,
 * alerting with the severity the issue had. An ignored or already resolved
 * issue is left as it is.
 */
function healthy(state: IssueState): Step {
  const { issue } = state;
  const open = issue !== null && issue.status === "unresolved";

  if (!open && !state.periodOpen) {
    return { next: state, change: null };
  }

  return {
    next: {
      issue: open ? { ...issue, status: "resolved" } : issue,
      periodOpen: false,
    },
    change: {
      createIssue: null,
      activity: open ? "resolved" : null,
      openPeriod: false,
      transition: open ? { type: "recovery", severity: severityOf(issue.level) } : null,
      closePeriod: state.periodOpen,
      update: open ? { kind: "healthy" } : null,
    },
  };
}

/** The scope's next state and the writes that get it there; `change` is null when nothing changes. */
export function applySignal(state: IssueState, signal: Signal): Step {
  return signal.health === "failing" ? failing(state, signal) : healthy(state);
}

/** A run of observations folded in order, with each one's writes. */
export function planIssues(state: IssueState, signals: (Signal | null)[]): IssuePlan {
  let current = state;

  // A null signal is an observation the lifecycle ignores (degraded, unknown).
  const changes = signals.map((signal) => {
    if (signal === null) {
      return null;
    }

    const { next, change } = applySignal(current, signal);

    current = next;

    return change;
  });

  return { state, changes };
}

/**
 * A cron write with its issue plan: each decided outcome is one observation of
 * the environment, failing at high severity. A success that keeps the
 * environment failing (short of the recovery streak) is not a sighting.
 */
export function withCronIssues(write: CronWrite, issue: IssueState, now: number): PlannedCronWrite {
  const signals = write.decisions.map(({ outcome, health }): Signal | null => {
    if (health === "failing") {
      return { health, severity: "high", sighted: outcome !== "ok", at: now };
    }

    return health === "healthy" ? { health, severity: null, sighted: false, at: now } : null;
  });

  return { ...write, issues: planIssues(issue, signals) };
}
