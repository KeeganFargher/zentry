// Planning, part 2: turn buckets into the rows the consumer writes in one
// transaction (DESIGN.md §7.4, step C).

import type { RateLimitReason } from "@/shared/contract";
import type {
  AggregateRow,
  BatchState,
  BatchWrites,
  EventRow,
  GroupStatRow,
  LimitRow,
  NewGroupRow,
  ProjectQuota,
  ProjectStatRow,
  TagRow,
  UsageRow,
} from "@/shared/plan";
import { HOUR, hourBucket, monthBucket } from "@/shared/time";

import { buildBuckets, dropDuplicates } from "./buckets";
import type { Bucket, Prepared, Sampled } from "./buckets";

export type PlanInput = {
  prepared: Prepared[];
  state: BatchState;
  now: number;
  maxStoredPerGroupHour: number;
};

export type Plan = { writes: BatchWrites; stored: Prepared[] };

function newest(bucket: Bucket): Prepared | undefined {
  return bucket.events.at(-1)?.item;
}

function newestStoredId(bucket: Bucket): string | null {
  return bucket.events.findLast((entry) => entry.stored)?.item.event.eventId ?? null;
}

function aggregateRow(bucket: Bucket): AggregateRow[] {
  const latest = newest(bucket);
  const oldest = bucket.events[0]?.item;

  if (latest === undefined || oldest === undefined) {
    return [];
  }

  return [
    {
      p: bucket.projectId,
      h: bucket.hash,
      n: bucket.events.length,
      first_ts: oldest.event.timestamp,
      last_ts: latest.event.timestamp,
      last_received: Math.max(...bucket.events.map((entry) => entry.item.event.receivedAt)),
      eid: newestStoredId(bucket),
      title: latest.event.title,
      culprit: latest.event.culprit,
      level: latest.event.level,
      metadata: JSON.stringify(latest.metadata),
    },
  ];
}

function newGroupRow(bucket: Bucket): NewGroupRow[] {
  const [aggregate] = aggregateRow(bucket);
  const oldest = bucket.events[0]?.item.event;

  if (bucket.groupId !== null || aggregate === undefined || oldest === undefined) {
    return [];
  }

  return [
    {
      p: aggregate.p,
      h: aggregate.h,
      title: aggregate.title,
      culprit: aggregate.culprit,
      level: aggregate.level,
      platform: oldest.platform,
      metadata: aggregate.metadata,
      first_ts: aggregate.first_ts,
      eid: aggregate.eid,
      release: oldest.release,
    },
  ];
}

function eventRow(bucket: Bucket, { item }: Sampled): EventRow {
  return {
    p: bucket.projectId,
    e: item.event.eventId,
    h: bucket.hash,
    ts: item.event.timestamp,
    rx: item.event.receivedAt,
    level: item.event.level,
    platform: item.event.platform,
    release: item.event.release,
    env: item.event.environment,
    user: item.userLabel,
    title: item.event.title,
    size: item.json.length,
  };
}

function groupStatRows(bucket: Bucket): GroupStatRow[] {
  const rows = new Map<number, GroupStatRow>();

  for (const entry of bucket.events) {
    const row = rows.get(entry.hour) ?? {
      p: bucket.projectId,
      h: bucket.hash,
      b: entry.hour,
      n: 0,
      stored: 0,
    };

    row.n += 1;
    row.stored += entry.stored ? 1 : 0;
    rows.set(entry.hour, row);
  }

  return [...rows.values()];
}

function tagRows(bucket: Bucket): TagRow[] {
  const rows = new Map<string, TagRow>();

  for (const { item } of bucket.events) {
    for (const [k, v] of item.tags) {
      const key = `${k}\u0000${v}`;
      const row = rows.get(key) ?? { p: bucket.projectId, h: bucket.hash, k, v, n: 0, ts: 0 };

      row.n += 1;
      row.ts = Math.max(row.ts, item.event.timestamp);
      rows.set(key, row);
    }
  }

  return [...rows.values()];
}

function projectStatRows(groupStats: GroupStatRow[]): ProjectStatRow[] {
  const rows = new Map<string, ProjectStatRow>();

  for (const stat of groupStats) {
    const key = `${stat.p}:${stat.b}`;
    const row = rows.get(key) ?? { p: stat.p, b: stat.b, n: 0, stored: 0 };

    row.n += stat.n;
    row.stored += stat.stored;
    rows.set(key, row);
  }

  return [...rows.values()];
}

type HourlyLimit = { max: number; reason: RateLimitReason };

function hourlyLimits(quota: ProjectQuota): HourlyLimit[] {
  const limits: HourlyLimit[] = [];

  if (quota.maxEventsPerHour !== null) {
    limits.push({ max: quota.maxEventsPerHour, reason: "project_quota" });
  }

  if (quota.spikeLimitPerHour !== null) {
    limits.push({ max: quota.spikeLimitPerHour, reason: "spike_protection" });
  }

  return limits;
}

/**
 * Projects whose count for the current hour now exceeds their quota or their
 * spike threshold. When both are passed, the lower one is the reason given,
 * since it is the one that would still hold if the other were raised.
 */
function limitRows(projectStats: ProjectStatRow[], input: PlanInput): LimitRow[] {
  const hour = hourBucket(input.now);
  const rows: LimitRow[] = [];

  for (const quota of input.state.quotas) {
    const added = projectStats.find((row) => row.p === quota.projectId && row.b === hour)?.n ?? 0;
    const received = quota.received + added;

    const [binding] = hourlyLimits(quota)
      .filter((limit) => received > limit.max)
      .toSorted((a, b) => a.max - b.max);

    if (binding !== undefined) {
      rows.push({ p: quota.projectId, until: hour + HOUR, reason: binding.reason });
    }
  }

  return rows;
}

/**
 * Accepted events per organization and UTC month, for the monthly cap. A
 * project with no quota row was deleted while its events were queued; like
 * E7, its events are not counted.
 */
function usageRows(projectStats: ProjectStatRow[], quotas: ProjectQuota[]): UsageRow[] {
  const organizationOf = new Map(quotas.map((quota) => [quota.projectId, quota.organizationId]));
  const rows = new Map<string, UsageRow>();

  for (const stat of projectStats) {
    const organization = organizationOf.get(stat.p);

    if (organization === undefined) {
      continue;
    }

    const month = monthBucket(stat.b);
    const key = `${organization}:${month}`;
    const row = rows.get(key) ?? { o: organization, m: month, n: 0 };

    row.n += stat.n;
    rows.set(key, row);
  }

  return [...rows.values()];
}

export function planBatch(input: PlanInput): Plan {
  const fresh = dropDuplicates(input.prepared, input.state.existingEvents);
  const buckets = buildBuckets(fresh, input.state, input.maxStoredPerGroupHour);
  const groupStats = buckets.flatMap(groupStatRows);
  const projectStats = projectStatRows(groupStats);
  const storedEntries = buckets.flatMap((bucket) => bucket.events.filter((entry) => entry.stored));

  return {
    stored: storedEntries.map((entry) => entry.item),
    writes: {
      newGroups: buckets.flatMap(newGroupRow),
      metricEvents: fresh.map(({ event }) => ({
        project: event.projectId,
        eventId: event.eventId,
        received: event.receivedAt,
        environment: event.environment,
        level: event.level,
      })),
      aggregates: buckets.flatMap(aggregateRow),
      events: buckets.flatMap((bucket) =>
        bucket.events.flatMap((entry) => (entry.stored ? [eventRow(bucket, entry)] : [])),
      ),
      groupStats,
      tags: buckets.flatMap(tagRows),
      projectStats,
      limits: limitRows(projectStats, input),
      usage: usageRows(projectStats, input.state.quotas),
    },
  };
}
