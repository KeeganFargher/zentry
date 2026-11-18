// The rows the consumer reads before planning a batch and writes after it.
// Field names are short because each list is sent to D1 as one JSON parameter
// and read back with json_each (DESIGN.md §7.4).

import type { IssueStatus, RateLimitReason } from "./contract";

// ── Read results ─────────────────────────────────────────────────────────

export type EventKey = { p: number; e: string };

export type HashKey = { p: number; h: string };

export type KnownGroup = {
  projectId: number;
  hash: string;
  groupId: number;
  status: IssueStatus;
  resolvedAt: number | null;
};

export type GroupHourKey = { g: number; b: number };

export type GroupHourStored = { groupId: number; bucket: number; stored: number };

export type ProjectQuota = {
  projectId: number;
  organizationId: number;
  maxEventsPerHour: number | null;
  /** Null while spike protection is off. */
  spikeLimitPerHour: number | null;
  received: number;
};

export type BatchState = {
  existingEvents: EventKey[];
  knownGroups: KnownGroup[];
  storedThisHour: GroupHourStored[];
  quotas: ProjectQuota[];
};

// ── Write rows ───────────────────────────────────────────────────────────

/** E1: one new issue. */
export type NewGroupRow = {
  p: number;
  h: string;
  title: string;
  culprit: string;
  level: string;
  platform: string;
  metadata: string;
  first_ts: number;
  eid: string | null;
  release: string | null;
};

/** E2 and E3: one row per issue touched by the batch. */
export type AggregateRow = {
  p: number;
  h: string;
  n: number;
  first_ts: number;
  last_ts: number;
  last_received: number;
  eid: string | null;
  title: string;
  culprit: string;
  level: string;
  metadata: string;
};

/** E4: one stored event. */
export type EventRow = {
  p: number;
  e: string;
  h: string;
  ts: number;
  rx: number;
  level: string;
  platform: string;
  release: string | null;
  env: string;
  user: string | null;
  title: string;
  size: number;
};

/** E5: issue counts per hour. */
export type GroupStatRow = { p: number; h: string; b: number; n: number; stored: number };

/** E6: tag counts per issue. */
export type TagRow = { p: number; h: string; k: string; v: string; n: number; ts: number };

/** E7: project counts per hour. */
export type ProjectStatRow = { p: number; b: number; n: number; stored: number };

/** E8: a project that passed its hourly quota or spike threshold. */
export type LimitRow = { p: number; until: number; reason: RateLimitReason };

/** E9: events accepted in one UTC month by one organization's projects. */
export type UsageRow = { o: number; m: number; n: number };

export type MetricEventRow = {
  project: number;
  eventId: string;
  received: number;
  environment: string;
  level: string;
};

export type BatchWrites = {
  metricEvents: MetricEventRow[];
  newGroups: NewGroupRow[];
  aggregates: AggregateRow[];
  events: EventRow[];
  groupStats: GroupStatRow[];
  tags: TagRow[];
  projectStats: ProjectStatRow[];
  limits: LimitRow[];
  usage: UsageRow[];
};
