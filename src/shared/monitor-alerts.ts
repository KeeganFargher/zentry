import { z } from "zod";

export const MonitorTrigger = z.enum(["failure", "escalation", "recovery"]);
export const MonitorChannel = z.enum(["email", "push"]);

export const MonitorRule = z.strictObject({
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean().default(true),
  channels: z
    .array(MonitorChannel)
    .min(1)
    .max(2)
    .refine((values) => new Set(values).size === values.length),
  triggers: z
    .array(MonitorTrigger)
    .min(1)
    .max(3)
    .refine((values) => new Set(values).size === values.length),
  throttleSeconds: z.int().min(0).max(86400).default(300),
  audience: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("project") }),
    z.object({ kind: z.literal("owner") }),
    z.object({ kind: z.literal("members"), userIds: z.array(z.int().positive()).min(1).max(20) }),
  ]),
  environment: z.string().trim().min(1).max(64).optional(),
  priority: z.literal("high").optional(),
});

export type NewMonitorRule = z.output<typeof MonitorRule>;

export type ApiMonitorRule = NewMonitorRule & { id: string; version: number };

export type MonitorTriggerName = z.output<typeof MonitorTrigger>;

export type MonitorChannelName = z.output<typeof MonitorChannel>;
