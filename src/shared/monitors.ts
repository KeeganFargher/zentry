import { CronExpressionParser } from "cron-parser";
import { z } from "zod";

import { MINUTE } from "./time";

const Environment = z.string().trim().min(1).max(64);

/**
 * Sentry's monitor slug: Django's `slugify`, cut to 50 characters, with
 * dashes stripped from the ends (src/sentry/monitors/types.py). SDKs send
 * whatever the application passed, so "Nightly Export" must find the monitor
 * whose slug is "nightly-export", as it does on Sentry.
 */
export function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replaceAll(/[^ -~]/gu, "")
    .toLowerCase()
    .replaceAll(/[^\w\s-]/gu, "")
    .replaceAll(/[-\s]+/gu, "-")
    .replaceAll(/^[-_]+|[-_]+$/gu, "")
    .slice(0, 50)
    .replaceAll(/^-+|-+$/gu, "");
}

const Slug = z
  .string()
  .regex(/^[a-z0-9_-]{1,50}$/u)
  .refine((slug) => slugify(slug) === slug, "use the slug an SDK's monitor name becomes");

const MetricConfig = z.strictObject({
  windowSeconds: z.union([z.literal(300), z.literal(900), z.literal(3600)]),
  threshold: z.int().nonnegative(),
  warningThreshold: z.int().nonnegative().optional(),
  comparator: z.enum(["gte", "gt", "lte", "lt"]).default("gte"),
  level: z.enum(["error", "fatal"]).optional(),
  recoveryThreshold: z.int().nonnegative().optional(),
  environment: Environment.optional(),
});

// Sentry maps these nicknames before validating (src/sentry/monitors/validators.py).
const CRONTAB_NICKNAMES = new Map([
  ["@yearly", "0 0 1 1 *"],
  ["@annually", "0 0 1 1 *"],
  ["@monthly", "0 0 1 * *"],
  ["@weekly", "0 0 * * 0"],
  ["@daily", "0 0 * * *"],
  ["@midnight", "0 0 * * *"],
  ["@hourly", "0 * * * *"],
]);

const Crontab = z
  .string()
  .trim()
  .max(100)
  // Anything that is not a nickname is checked as a five-field crontab.
  .transform((value) => CRONTAB_NICKNAMES.get(value.toLowerCase()) ?? value)
  .pipe(
    z
      .string()
      .regex(/^(?:[\w*,/-]+ +){4}[\w*,/-]+$/u, "a crontab has five fields")
      .refine(parsesAsCrontab, "invalid crontab value"),
  );

/** The regex checks the shape; cron-parser rejects values such as minute 99. */
function parsesAsCrontab(expression: string): boolean {
  try {
    CronExpressionParser.parse(expression);

    return true;
  } catch {
    return false;
  }
}

const IntervalUnit = z.enum(["minute", "hour", "day", "week", "month", "year"]);

export const CronSchedule = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("crontab"), crontab: Crontab }),
  z.strictObject({
    type: z.literal("interval"),
    count: z.int().min(1).max(1000),
    unit: IntervalUnit,
  }),
]);

export type CronSchedule = z.output<typeof CronSchedule>;

const Timezone = z
  .string()
  .min(1)
  .max(64)
  .refine((zone) => {
    // Intl is the runtime's timezone database, so it decides what is valid.
    try {
      return new Intl.DateTimeFormat("en", { timeZone: zone }).resolvedOptions().timeZone !== "";
    } catch {
      return false;
    }
  }, "unknown timezone");

/**
 * Bounds and defaults are Sentry's (src/sentry/monitors/validators.py and
 * constants.py): a one-minute margin, 30 minutes of runtime, and one failure
 * to open or success to recover, up to 28 days, 7 days and 720.
 */
export const CronConfig = z.strictObject({
  slug: Slug,
  schedule: CronSchedule,
  timezone: Timezone.default("UTC"),
  graceMinutes: z.int().min(1).max(40_320).default(1),
  maxRuntimeMinutes: z.int().min(1).max(10_080).default(30),
  failureThreshold: z.int().min(1).max(720).default(1),
  recoveryThreshold: z.int().min(1).max(720).default(1),
});

export type CronSettings = z.output<typeof CronConfig>;

export type CronSettingsInput = z.input<typeof CronConfig>;

const Common = z.strictObject({
  projectId: z.int().positive(),
  notify: z.boolean().default(false),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(2000).default(""),
  ownerId: z.int().positive().nullable().default(null),
  alertRuleIds: z
    .array(z.uuid())
    .max(10)
    .refine((values) => new Set(values).size === values.length)
    .default([]),
});

const MetricMonitor = Common.extend({ type: z.literal("metric"), config: MetricConfig });

const CronMonitor = Common.extend({ type: z.literal("cron"), config: CronConfig });

export const UptimeConfig = z.strictObject({
  url: z.url().max(512),
  method: z.enum(["GET", "HEAD"]).default("GET"),
  environment: Environment.optional(),
  successCodes: z.array(z.int().min(100).max(599)).min(1).max(20).optional(),
  intervalMinutes: z.union([
    z.literal(1),
    z.literal(5),
    z.literal(10),
    z.literal(20),
    z.literal(30),
    z.literal(60),
  ]),
  timeoutMs: z.int().min(1000).max(15000).default(5000),
  failureThreshold: z.int().min(1).max(10).default(3),
  recoveryThreshold: z.int().min(1).max(10).default(1),
});

const UptimeMonitor = Common.extend({ type: z.literal("uptime"), config: UptimeConfig });

export type UptimeSettings = z.output<typeof UptimeConfig>;

export const CreateMonitor = z.discriminatedUnion("type", [
  MetricMonitor,
  CronMonitor,
  UptimeMonitor,
]);

export const LastIssue = z.object({
  id: z.int(),
  shortId: z.string(),
  title: z.string(),
  status: z.enum(["unresolved", "resolved", "ignored"]),
  lastSeen: z.int(),
});

/** Who created a monitor: a member, a member since deleted, or an SDK's monitor_config. */
export const Creator = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("member"), userId: z.int().positive() }),
  z.object({ kind: z.literal("former_member") }),
  z.object({ kind: z.literal("sdk") }),
]);

export const MonitorFields = z.object({
  id: z.uuid(),
  status: z.enum(["active", "paused", "archived"]),
  health: z.enum(["awaiting_data", "healthy", "degraded", "failing", "unknown"]),
  version: z.int().positive(),
  evaluatedAt: z.int().nullable(),
  mutedUntil: z.int().nullable(),
  severity: z.enum(["medium", "high"]).nullable(),
  issueId: z.int().nullable(),
  lastIssue: LastIssue.nullable(),
  creator: Creator,
  createdAt: z.int(),
});

const ZERO_CHECK_IN_ID = "00000000000000000000000000000000";

/** Sentry turns a margin or runtime below 1 into 1 and caps it at the maximum. */
function clamped(max: number) {
  return z
    .int()
    .nullish()
    .transform((value) =>
      value === null || value === undefined ? undefined : Math.min(Math.max(value, 1), max),
    );
}

const Present = <T extends z.ZodType>(schema: T) =>
  schema.nullish().transform((value) => (value === null ? undefined : value));

/**
 * The SDK's `monitor_config`, mapped to Zentry's field names. On Sentry it
 * upserts the monitor (develop docs, sdk/telemetry/check-ins). Zentry uses it
 * only to create a monitor the first time its slug is seen; the UI owns the
 * monitor after that. Sentry clamps an oversized margin or runtime rather than
 * rejecting the check-in (monitor_consumer.py), so this does too.
 */
const WireMonitorConfig = z
  .object({
    schedule: z.discriminatedUnion("type", [
      z.object({ type: z.literal("crontab"), value: z.string() }),
      z.object({ type: z.literal("interval"), value: z.int().positive(), unit: IntervalUnit }),
    ]),
    checkin_margin: clamped(40_320),
    max_runtime: clamped(10_080),
    timezone: Present(z.string()),
    failure_issue_threshold: Present(z.int()),
    recovery_threshold: Present(z.int()),
  })
  .transform((config) => ({
    schedule:
      config.schedule.type === "crontab"
        ? { type: "crontab", crontab: config.schedule.value }
        : { type: "interval", count: config.schedule.value, unit: config.schedule.unit },
    timezone: config.timezone,
    graceMinutes: config.checkin_margin,
    maxRuntimeMinutes: config.max_runtime,
    failureThreshold: config.failure_issue_threshold,
    recoveryThreshold: config.recovery_threshold,
  }));

export type MonitorConfigRequest = z.output<typeof WireMonitorConfig>;

/** The monitor an SDK's monitor_config asks for; null when its values are out of bounds. */
export function provisionedConfig(
  slug: string,
  request: MonitorConfigRequest,
): CronSettings | null {
  const result = CronConfig.safeParse({ slug, ...request });

  return result.success ? result.data : null;
}

/**
 * A `check_in` envelope item, per the SDK wire format. Unknown fields such as
 * `release` and `contexts` are allowed and ignored.
 */
export const CheckIn = z
  .object({
    check_in_id: z
      .string()
      .regex(/^(?:[\da-f]{32}|[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})$/iu)
      .transform((id) => id.replaceAll("-", "").toLowerCase()),
    monitor_slug: z.string().max(128).transform(slugify).pipe(Slug),
    environment: Environment.default("production"),
    status: z.enum(["in_progress", "ok", "error"]),
    // Seconds, as the SDKs send it.
    duration: z
      .number()
      .nonnegative()
      .max(7 * 24 * 60 * 60)
      .nullish()
      .transform((value) =>
        value === null || value === undefined ? null : Math.round(value * 1000),
      ),
    // A malformed monitor_config does not reject the check-in: Sentry only
    // needs it to create a monitor, and ignores it for one that exists.
    monitor_config: z
      .union([WireMonitorConfig, z.unknown().transform(() => "invalid" as const)])
      .optional(),
  })
  .transform(({ check_in_id, monitor_slug, environment, status, duration, monitor_config }) => ({
    // The all-zero ID means "the latest open check-in in this environment".
    checkInId: check_in_id === ZERO_CHECK_IN_ID ? null : check_in_id,
    slug: monitor_slug,
    environment,
    status,
    durationMs: duration,
    monitorConfig: monitor_config,
  }));

export type MonitorCheckIn = z.output<typeof CheckIn>;

/** A check-in item as an SDK sends it. */
export type WireCheckIn = z.input<typeof CheckIn>;

/**
 * How long ingest trusts its cached list of projects that have metric
 * monitors. Coverage starts this long after a project's first metric monitor
 * (migrations/0007_monitors.sql, metric_capture_started).
 */
export const METRIC_CAPTURE_CACHE_MS = MINUTE;

/** Monitors an organization may have that are not archived, including SDK-created ones. */
export const MAX_MONITORS_PER_ORGANIZATION = 100;

export type NewMonitor = z.output<typeof CreateMonitor>;

export type UptimeJob = { id: string; token: string } | { previewId: string };

export type ScheduledUptimeJob = Extract<UptimeJob, { token: string }>;

export type ApiMonitor = NewMonitor & z.output<typeof MonitorFields>;
