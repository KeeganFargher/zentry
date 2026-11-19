// Cron check-in state, shared by the pure rules in src/core/cron-checkins.ts
// and the D1 store in src/db/cron-store.ts.

import type { IssuePlan } from "./monitor-issues";

export type CheckInStatus = "in_progress" | "ok" | "error" | "missed" | "timeout";

export type Outcome = Exclude<CheckInStatus, "in_progress">;

/** One monitor environment, as Sentry's MonitorEnvironment. */
export type EnvironmentState = {
  /** `active` until the first decided outcome, as Sentry's MonitorStatus. */
  status: "active" | "ok" | "error";
  /** The schedule anchor: when the latest real check-in started. */
  lastCheckIn: number | null;
  nextCheckIn: number | null;
  /** `nextCheckIn` plus the margin, when a check-in that has not arrived is missed. */
  nextCheckInLatest: number | null;
  /** When the newest run whose outcome moved the streaks started. */
  lastDecided: number | null;
  failures: number;
  successes: number;
};

/** One check-in, or one missed expected check-in, as Sentry's MonitorCheckIn. */
export type CheckInRow = {
  checkInId: string;
  status: CheckInStatus;
  /** When the run's first report arrived; the expected time for a missed row. */
  dateAdded: number;
  expectedAt: number | null;
  timeoutAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
};

export type StoredCheckIn = CheckInRow & { id: number; environment: string };

export type Health = "awaiting_data" | "healthy" | "degraded" | "failing";

/** An outcome that moved the streaks, for the monitor's history and issue. */
export type Decision = { outcome: Outcome; row: CheckInRow; health: Health };

/** What one compare-and-swap write stores for an environment. */
export type CronWrite = {
  state: EnvironmentState;
  health: Health;
  /** Each row with the stored row it replaces, or null for a new row. */
  rows: { row: CheckInRow; stored: StoredCheckIn | null }[];
  decisions: Decision[];
};

/** A cron write with the issue lifecycle planned for its decisions. */
export type PlannedCronWrite = CronWrite & { issues: IssuePlan };

export const NEW_ENVIRONMENT: EnvironmentState = {
  status: "active",
  lastCheckIn: null,
  nextCheckIn: null,
  nextCheckInLatest: null,
  lastDecided: null,
  failures: 0,
  successes: 0,
};

/** A cron check-in as Sentry's check-in table shows it, missed slots included. */
export type CronCheckInView = {
  checkInId: string;
  environment: string;
  status: "in_progress" | "ok" | "error" | "missed" | "timeout";
  /** When the run's first report arrived; null for a missed slot. */
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
  expectedAt: number | null;
};

/** Check-ins Zentry accepted but could not apply, by slug and environment. */
export type CronUnrecognized = {
  projectId: number;
  slug: string;
  environment: string;
  reason: "unknown_slug" | "invalid_config" | "monitor_limit" | "environment_limit" | "inactive";
  count: number;
  lastSeen: number;
};
