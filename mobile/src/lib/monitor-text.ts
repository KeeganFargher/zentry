// Words for the monitor screens, in Sentry's (static/app/views/insights/crons
// and its uptime and detector counterparts). The web UI has the same labels
// in ui/src/lib/monitor-text.ts; the two apps build separately, so this is a
// copy of the part the phone shows, kept in step by hand.

import type { ApiMonitor, CronCheckInView, TimelineStatus } from "@contract";
import cronstrue from "cronstrue";

export type MonitorType = ApiMonitor["type"];

type CronMonitor = Extract<ApiMonitor, { type: "cron" }>;

type MetricSettings = Extract<ApiMonitor, { type: "metric" }>["config"];

type Comparator = MetricSettings["comparator"];

export const TYPE_LABELS: Record<MonitorType, string> = {
  metric: "Metric",
  cron: "Cron",
  uptime: "Uptime",
};

function every(count: number, unit: string): string {
  return count === 1 ? `Every ${unit}` : `Every ${count} ${unit}s`;
}

/** "At 02:00 AM" or "Every 5 minutes", as Sentry's `scheduleAsText`. */
export function scheduleText(schedule: CronMonitor["config"]["schedule"]): string {
  if (schedule.type === "interval") {
    return every(schedule.count, schedule.unit);
  }

  try {
    return cronstrue.toString(schedule.crontab, { verbose: false });
  } catch {
    // The API accepts only crontabs cron-parser can run, but cronstrue's
    // grammar differs slightly; Sentry shows the same words when it fails.
    return "Unknown schedule";
  }
}

/** "Every 1 minute" for uptime, as Sentry's list details row. */
export function everyMinutes(minutes: number): string {
  return minutes === 60 ? "Every 1 hour" : `Every ${minutes} minute${minutes === 1 ? "" : "s"}`;
}

export const CHECK_IN_LABELS: Record<CronCheckInView["status"], string> = {
  ok: "Okay",
  error: "Failed",
  in_progress: "In Progress",
  missed: "Missed",
  timeout: "Timed Out",
};

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
 * A tick status's name for one monitor type: a metric window that is fine is
 * "Resolved", as the web's metric legend says, rather than a check-in's "Okay".
 */
export function tickLabel(type: MonitorType, status: TimelineStatus): string {
  return type === "metric" && status === "ok" ? "Resolved" : TICK_LABELS[status];
}

/**
 * Which status a merged tick shows: the first present in this order, as
 * Sentry's `getAggregateStatus`, except that unknown ranks last. Here it also
 * marks skipped uptime checks and metric windows awaiting data, which must not
 * hide a bucket's real failures (the web UI ranks them the same way).
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

/** The threshold's comparator in words, for the detail screen. */
export const COMPARATOR_TEXT: Record<Comparator, string> = {
  gt: "Above",
  gte: "Above or equal to",
  lt: "Below",
  lte: "Below or equal to",
};

/**
 * When a metric monitor resolves, as the web's resolve text: a custom value
 * is inclusive ("below or equal to 3" for an "above" monitor); by default it
 * is the medium threshold (else the high one), exclusive of the detection
 * comparator, as src/db/metric-query.ts recoveryCrossed.
 */
export function metricResolveText(config: MetricSettings): string {
  if (config.recoveryThreshold !== undefined) {
    const direction = config.comparator.startsWith("gt")
      ? "below or equal to"
      : "above or equal to";

    return `When the count is ${direction} ${config.recoveryThreshold}`;
  }

  const base = config.warningThreshold ?? config.threshold;

  const text: Record<Comparator, string> = {
    gt: `below or equal to ${base}`,
    gte: `below ${base}`,
    lt: `above or equal to ${base}`,
    lte: `above ${base}`,
  };

  return `When the count is ${text[config.comparator]}`;
}

const COMPARATOR_SIGNS: Record<Comparator, string> = {
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
};

/** The details line under a monitor's name, as Sentry's detector list row. */
export function detailsOf(monitor: ApiMonitor): string[] {
  if (monitor.type === "cron") {
    return [scheduleText(monitor.config.schedule)];
  }

  if (monitor.type === "uptime") {
    return [monitor.config.url, everyMinutes(monitor.config.intervalMinutes)];
  }

  const { comparator, threshold, windowSeconds, environment } = monitor.config;

  return [
    environment ?? "All environments",
    `count() over ${windowSeconds / 60}m`,
    `${COMPARATOR_SIGNS[comparator]}${threshold} high`,
  ];
}
