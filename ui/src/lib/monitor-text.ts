// Words and labels for the monitor pages, matching Sentry's Monitors UI
// (static/app/views/insights/crons/utils.tsx and its uptime counterpart).

import type { ApiMonitor, CronCheckInView, TimelineStatus } from "@contract";
import cronstrue from "cronstrue";

export type MonitorType = ApiMonitor["type"];

type MetricSettings = Extract<ApiMonitor, { type: "metric" }>["config"];

type Comparator = MetricSettings["comparator"];

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
 * uptime `checkStatusPrecedent`, except that unknown ranks last. Sentry
 * puts it first, but here it also marks skipped uptime checks and metric
 * windows awaiting data, which would hide a bucket's real failures.
 */
export const TICK_PRECEDENCE: TimelineStatus[] = [
  "high",
  "downtime",
  "error",
  "timeout",
  "failure",
  "missed",
  "medium",
  "ok",
  "success",
  // Last: an unknown is a skipped or paused check, and one in a bucket of
  // real results must not hide the downtime around it.
  "unknown",
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

/** How a threshold reads for each comparator, in Sentry's words. */
export const COMPARATOR_TEXT: Record<Comparator, string> = {
  gt: "Above",
  gte: "Above or equal to",
  lt: "Below",
  lte: "Below or equal to",
};

/** The comparator as a symbol, for the list row's compact threshold. */
export const COMPARATOR_SIGNS: Record<Comparator, string> = {
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
};

/**
 * The count that resolves by default, as src/db/metric-query.ts recoveryCrossed:
 * the medium threshold (else the high one), exclusive of the detection
 * comparator, so "above or equal to 10" resolves below 10.
 */
export function defaultResolveText(config: MetricSettings): string {
  const base = config.warningThreshold ?? config.threshold;

  const text: Record<Comparator, string> = {
    gt: `below or equal to ${base}`,
    gte: `below ${base}`,
    lt: `above or equal to ${base}`,
    lte: `above ${base}`,
  };

  return text[config.comparator];
}

/** A custom resolve value is inclusive: at or below it for "above", at or above it for "below". */
export function resolveDirection(config: MetricSettings): string {
  return config.comparator.startsWith("gt") ? "Below or equal to" : "Above or equal to";
}

export function customResolveText(config: MetricSettings, recovery: number): string {
  return `${resolveDirection(config).toLowerCase()} ${recovery}`;
}
