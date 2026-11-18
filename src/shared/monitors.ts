import { z } from "zod";

const Environment = z.string().trim().min(1).max(64);

const Slug = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);

const MetricConfig = z.strictObject({
  windowSeconds: z.union([z.literal(300), z.literal(900), z.literal(3600)]),
  threshold: z.int().positive(),
  recoveryThreshold: z.int().nonnegative().optional(),
  environment: Environment.optional(),
});

const CronTiming = z.strictObject({
  slug: Slug,
  environment: Environment,

  graceMinutes: z.int().min(1).max(1440).default(1),
  maxRuntimeMinutes: z.int().min(1).max(1440).default(30),
  failureThreshold: z.int().min(1).max(10).default(1),
  recoveryThreshold: z.int().min(1).max(10).default(1),
});

export const CronConfig = z.union([
  CronTiming.extend({ intervalMinutes: z.int().min(1).max(10080) }),
  CronTiming.extend({
    expression: z
      .string()
      .trim()
      .max(100)
      .regex(/^(?:[\w*,/-]+ +){4}[\w*,/-]+$/),
    timezone: z.string().min(1).max(64).default("UTC"),
  }),
]);

export type CronSettings = z.output<typeof CronConfig>;

const Common = z.strictObject({
  projectId: z.int().positive(),
  notify: z.boolean().default(false),
  name: z.string().trim().min(1).max(100),
});

const MetricMonitor = Common.extend({ type: z.literal("metric"), config: MetricConfig });

const CronMonitor = Common.extend({ type: z.literal("cron"), config: CronConfig });

export const UptimeConfig = z.strictObject({
  url: z.url().max(512),
  method: z.enum(["GET", "HEAD"]).default("GET"),
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

export const MonitorFields = z.object({
  id: z.uuid(),
  status: z.enum(["active", "paused", "archived"]),
  health: z.enum(["awaiting_data", "healthy", "degraded", "failing", "unknown"]),
  version: z.int().positive(),
  evaluatedAt: z.int().nullable(),
  issueId: z.int().nullable(),
  createdAt: z.int(),
});

export const CheckIn = z.object({
  check_in_id: z
    .string()
    .regex(/^(?:[\da-f]{32}|[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})$/i)
    .transform((id) => id.replaceAll("-", "").toLowerCase())
    .refine((id) => id !== "00000000000000000000000000000000", "check-in ID cannot be zero"),
  monitor_slug: Slug,
  environment: Environment.default("production"),
  status: z.enum(["in_progress", "ok", "error"]),
  duration: z.number().nonnegative().max(604800).optional(),
});

export type MonitorCheckIn = z.output<typeof CheckIn>;

export type NewMonitor = z.output<typeof CreateMonitor>;

export type UptimeJob = { id: string; token: string };

export type ApiMonitor = NewMonitor & z.output<typeof MonitorFields>;
