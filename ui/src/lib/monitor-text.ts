// Words and labels for the monitor pages, matching Sentry's Monitors UI
// (static/app/views/insights/crons/utils.tsx and its uptime counterpart).

import type { ApiMonitor, CronCheckInView, TimelineStatus } from "@contract";
import cronstrue from "cronstrue";

export type MonitorType = ApiMonitor["type"];

export const TYPE_LABELS: Record<MonitorType, string> = {
  metric: "Metric",
  cron: "Cron",
  uptime: "Uptime",
};

/** The path segment of each type's list, as Sentry's `/monitors/crons/`. */
export const TYPE_PATHS: Record<MonitorType, string> = {
  metric: "metrics",
  cron: "crons",
  uptime: "uptime",
};

type CronConfig = Extract<ApiMonitor, { type: "cron" }>["config"];

type Schedule = CronConfig["schedule"];

function plural(count: number, unit: string): string {
  return count === 1 ? `Every ${unit}` : `Every ${count} ${unit}s`;
}

/** "At 12:00 AM" or "Every 5 minutes", as Sentry's `scheduleAsText`. */
export function scheduleText(schedule: Schedule): string {
  if (schedule.type === "interval") {
    return plural(schedule.count, schedule.unit);
  }

  try {
    return cronstrue.toString(schedule.crontab, { verbose: false });
  } catch {
    // The API accepts only crontabs cron-parser can run, but cronstrue's
    // grammar differs slightly; Sentry shows the same fallback.
    return "Unknown schedule";
  }
}

export const CHECK_IN_LABELS: Record<CronCheckInView["status"], string> = {
  ok: "Okay",
  error: "Failed",
  in_progress: "In Progress",
  missed: "Missed",
  timeout: "Timed Out",
};

/** Labels for every status a timeline tick can have. */
export const TICK_LABELS: Record<TimelineStatus, string> = {
  ...CHECK_IN_LABELS,
  unknown: "Unknown",
  success: "Uptime",
  failure: "Failure",
  downtime: "Downtime",
  medium: "Medium priority",
  high: "High priority",
};

/**
 * Which status a merged tick shows: the first present in this order, as
 * Sentry's `getAggregateStatus` with its `checkInStatusPrecedent` and the
 * uptime `checkStatusPrecedent`.
 */
export const TICK_PRECEDENCE: TimelineStatus[] = [
  "unknown",
  "high",
  "downtime",
  "error",
  "timeout",
  "failure",
  "missed",
  "medium",
  "ok",
  "success",
  "in_progress",
];

export const HEALTH_LABELS: Record<ApiMonitor["health"], string> = {
  awaiting_data: "Waiting for data",
  healthy: "Healthy",
  degraded: "Degraded",
  failing: "Failing",
  unknown: "Unknown",
};

export function pluralize(count: number, one: string, many: string): string {
  return count === 1 ? one : `${count} ${many}`;
}

/** "Every 1 minute" for uptime, as Sentry's list details row. */
export function everyMinutes(minutes: number): string {
  return minutes === 60 ? "Every 1 hour" : `Every ${minutes} minute${minutes === 1 ? "" : "s"}`;
}
