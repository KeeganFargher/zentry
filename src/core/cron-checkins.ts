// Cron check-in state, after Sentry's monitor consumer and clock tasks:
// src/sentry/monitors/consumers/monitor_consumer.py, logic/mark_ok.py,
// logic/mark_failed.py, logic/incidents.py, clock_tasks/check_missed.py and
// clock_tasks/check_timeout.py. Every function here is pure: the store reads
// one environment and check-in, applies a function, and writes the result
// with a compare-and-swap, so these rules are tested without D1.

import type {
  CheckInRow,
  CronWrite,
  Decision,
  EnvironmentState,
  Health,
  Outcome,
  StoredCheckIn,
} from "@/shared/cron";
import type { CronSettings } from "@/shared/monitors";
import { DAY, MINUTE } from "@/shared/time";

import { nextCheckIn } from "./cron-schedule";

export type Change = {
  /** Null when nothing changes: a duplicate, or a report for a finished run. */
  row: CheckInRow | null;
  environment: EnvironmentState;
  decision: Decision | null;
};

/** A change that always writes its row: a decided outcome or a timeout. */
export type Decided = Change & { row: CheckInRow };

/** The missed rows one tick records for an environment, and its state after them. */
export type Catchup = { rows: CheckInRow[]; environment: EnvironmentState; decisions: Decision[] };

export type Incoming = {
  status: "in_progress" | "ok" | "error";
  durationMs: number | null;
};

// Sentry stops accepting updates to a check-in a week after it started.
const MAX_CHECK_IN_AGE = 7 * DAY;

export function health(environment: EnvironmentState): Health {
  if (environment.status === "error") {
    return "failing";
  }

  if (environment.failures > 0) {
    return "degraded";
  }

  return environment.status === "ok" ? "healthy" : "awaiting_data";
}

/**
 * A check-in that is not yet recorded. Every check-in creates a row, whenever
 * it arrives: a run that is early, late or extra is shown, not discarded.
 */
export function firstReport(
  config: CronSettings,
  environment: EnvironmentState,
  report: Incoming & { checkInId: string; now: number },
): Change {
  const { checkInId, status, durationMs, now } = report;
  const terminal = status !== "in_progress";

  const row: CheckInRow = {
    checkInId,
    status,
    dateAdded: now,
    // Read before the schedule moves, as Sentry does.
    expectedAt: environment.nextCheckIn,
    timeoutAt: terminal ? null : now + config.maxRuntimeMinutes * MINUTE,
    completedAt: terminal ? now : null,
    durationMs: terminal ? durationMs : null,
  };

  const anchored = anchor(config, environment, now);

  return terminal
    ? decide(config, anchored, { outcome: status, row })
    : { row, environment: anchored, decision: null };
}

/**
 * A later report for a recorded check-in. Finished runs never change; a
 * repeated `in_progress` extends the runtime deadline; a result after a
 * timeout records when the run ended but keeps the timeout, as in Sentry.
 */
export function laterReport(
  config: CronSettings,
  environment: EnvironmentState,
  report: Incoming & { row: CheckInRow; now: number },
): Change {
  const { row, status, durationMs, now } = report;
  const unchanged = { row: null, environment, decision: null };

  if (now > row.dateAdded + MAX_CHECK_IN_AGE || row.status === "ok" || row.status === "error") {
    return unchanged;
  }

  if (row.status === "missed") {
    throw new Error(`check-in ${row.checkInId} is a missed slot and has no SDK report`);
  }

  if (status === "in_progress") {
    if (row.status !== "in_progress") {
      return unchanged;
    }

    const extended = Math.min(
      now + config.maxRuntimeMinutes * MINUTE,
      row.dateAdded + MAX_CHECK_IN_AGE,
    );

    return { row: { ...row, timeoutAt: extended }, environment, decision: null };
  }

  const ended = { ...row, completedAt: now, durationMs: durationMs ?? now - row.dateAdded };

  if (row.status === "timeout") {
    return row.completedAt === null ? { row: ended, environment, decision: null } : unchanged;
  }

  return decide(config, anchor(config, environment, row.dateAdded), {
    outcome: status,
    row: { ...ended, status, timeoutAt: null },
  });
}

/**
 * Missed check-ins due by `now`, one row per expected slot, as Sentry's
 * check_missed. A missed row is backdated to its expected time and does not
 * move the anchor, so the next expectation follows the schedule from the slot
 * that was missed. At most `limit` per call, so one long gap cannot hold the
 * minute tick; the rest are caught up on the next tick.
 */
export function missedSlots(
  config: CronSettings,
  environment: EnvironmentState,
  input: { now: number; limit: number; newId: () => string },
): Catchup {
  let state = environment;
  const rows: CheckInRow[] = [];
  const decisions: Decision[] = [];

  while (
    rows.length < input.limit &&
    state.nextCheckIn !== null &&
    state.nextCheckInLatest !== null &&
    state.nextCheckInLatest <= input.now
  ) {
    const expected = state.nextCheckIn;

    const row: CheckInRow = {
      checkInId: input.newId(),
      status: "missed",
      dateAdded: expected,
      expectedAt: expected,
      timeoutAt: null,
      completedAt: null,
      durationMs: null,
    };

    const next = nextCheckIn(config.schedule, config.timezone, expected);
    const decided = decide(config, state, { outcome: "missed", row });

    state = {
      ...decided.environment,
      nextCheckIn: next,
      nextCheckInLatest: next + config.graceMinutes * MINUTE,
    };
    rows.push(row);

    if (decided.decision !== null) {
      decisions.push(decided.decision);
    }
  }

  return { rows, environment: state, decisions };
}

/** An open run past its deadline, as Sentry's check_timeout. */
export function timedOut(
  config: CronSettings,
  environment: EnvironmentState,
  row: CheckInRow,
): Decided {
  if (row.status !== "in_progress") {
    throw new Error(`check-in ${row.checkInId} is ${row.status}, not in progress`);
  }

  return decide(config, environment, { outcome: "timeout", row: { ...row, status: "timeout" } });
}

/**
 * Moves the schedule from the start of a real check-in, as Sentry's mark_ok
 * and mark_failed do. A check-in older than the current anchor leaves it, so a
 * long run that finishes late cannot pull the schedule backwards.
 */
function anchor(
  config: CronSettings,
  environment: EnvironmentState,
  start: number,
): EnvironmentState {
  if (environment.lastCheckIn !== null && start < environment.lastCheckIn) {
    return environment;
  }

  const next = nextCheckIn(config.schedule, config.timezone, start);

  return {
    ...environment,
    lastCheckIn: start,
    nextCheckIn: next,
    nextCheckInLatest: next + config.graceMinutes * MINUTE,
  };
}

/**
 * Applies an outcome to the streaks. Failures open an incident after
 * `failureThreshold` in a row and successes resolve it after
 * `recoveryThreshold`, as Sentry's incidents.py. An outcome for a run that
 * started before the last decided one is recorded but cannot undo it, which is
 * Sentry's "only if no newer OK or ERROR exists" rule.
 */
function decide(
  config: CronSettings,
  environment: EnvironmentState,
  input: { outcome: Outcome; row: CheckInRow },
): Decided {
  const { outcome, row } = input;

  if (environment.lastDecided !== null && row.dateAdded < environment.lastDecided) {
    return { row, environment, decision: null };
  }

  const succeeded = outcome === "ok";
  const failures = succeeded ? 0 : environment.failures + 1;
  const successes = succeeded ? environment.successes + 1 : 0;

  const status = succeeded
    ? environment.status !== "error" || successes >= config.recoveryThreshold
      ? "ok"
      : "error"
    : failures >= config.failureThreshold
      ? "error"
      : environment.status;

  const next = { ...environment, status, failures, successes, lastDecided: row.dateAdded };

  return { row, environment: next, decision: { outcome, row, health: health(next) } };
}

/**
 * The write for a change to one row: the stored row it replaces, or null for
 * a new one. Null when nothing changed.
 */
export function toWrite(input: { change: Change; stored: StoredCheckIn | null }): CronWrite | null {
  const { change, stored } = input;

  if (change.row === null) {
    return null;
  }

  return {
    state: change.environment,
    health: health(change.environment),
    rows: [{ row: change.row, stored }],
    decisions: change.decision === null ? [] : [change.decision],
  };
}

/** The write for the missed rows of one tick; null when none were due. */
export function catchupWrite(catchup: Catchup): CronWrite | null {
  if (catchup.rows.length === 0) {
    return null;
  }

  return {
    state: catchup.environment,
    health: health(catchup.environment),
    rows: catchup.rows.map((row) => ({ row, stored: null })),
    decisions: catchup.decisions,
  };
}
