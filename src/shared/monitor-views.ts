// What the monitor pages draw: timelines bucketed on the server, so a busy
// cron or a one-minute uptime check sends tens of buckets, not every row.

/**
 * A status for one timeline tick.
 * - Cron: a check-in status (Sentry's `CheckInStatus`).
 * - Uptime: `success`, `failure`, `downtime` (a failure while the incident is
 *   open) or `unknown`, as Sentry's uptime timeline.
 * - Metric: the severity decided for the window, `ok`, or `unknown`.
 */
export type TimelineStatus =
  | "ok"
  | "error"
  | "missed"
  | "timeout"
  | "in_progress"
  | "success"
  | "failure"
  | "downtime"
  | "unknown"
  | "medium"
  | "high";

export type TimelineBucket = {
  /** Which bucket, counting from `since` in steps of `bucketMs`. */
  index: number;
  /** The environment for cron; empty for a monitor with one scope. */
  scope: string;
  status: TimelineStatus;
  count: number;
  /** A metric's largest window count in the bucket; null for other types. */
  value: number | null;
};

export type MonitorTimeline = {
  since: number;
  until: number;
  bucketMs: number;
  buckets: TimelineBucket[];
};
