// Planning, part 1: drop duplicates, bucket events by issue, and decide which
// events are stored in full and which are only counted (flood sampling).

import type { IssueMetadata, Pair, StoredEvent } from "@/shared/contract";
import type { BatchState, EventKey, GroupHourKey, KnownGroup } from "@/shared/plan";
import { hourBucket } from "@/shared/time";

import { deriveMetadata } from "./derive";
import { computeHash } from "./grouping";
import type { Normalized } from "./normalize";
import { indexedTags, userLabel } from "./tags";

/** A normalized event plus everything derived from it. */
export type Prepared = {
  event: StoredEvent;
  json: string;
  hash: string;
  tags: Pair[];
  userLabel: string | null;
  metadata: IssueMetadata;
};

export type Sampled = { item: Prepared; hour: number; stored: boolean };

/** All of a batch's events for one issue, oldest first. */
export type Bucket = {
  projectId: number;
  /** A hash that maps to the issue; used to find it again when writing. */
  hash: string;
  /** Null when the batch creates the issue. */
  groupId: number | null;
  events: Sampled[];
};

export function prepareEvent(normalized: Normalized): Prepared {
  const { event, facts } = normalized;

  return {
    event,
    json: JSON.stringify(event),
    hash: computeHash(event),
    tags: indexedTags(event, facts),
    userLabel: userLabel(facts.user),
    metadata: deriveMetadata(event),
  };
}

function hashKey(projectId: number, hash: string): string {
  return `${projectId}:${hash}`;
}

function indexGroups(known: KnownGroup[]): Map<string, KnownGroup> {
  return new Map(known.map((group) => [hashKey(group.projectId, group.hash), group]));
}

/** Drops events already stored, and later copies of an event within the batch. */
export function dropDuplicates(prepared: Prepared[], existing: EventKey[]): Prepared[] {
  const seen = new Set(existing.map((key) => `${key.p}:${key.e}`));
  const fresh: Prepared[] = [];

  for (const item of prepared) {
    const key = `${item.event.projectId}:${item.event.eventId}`;

    if (!seen.has(key)) {
      seen.add(key);
      fresh.push(item);
    }
  }

  return fresh;
}

/** The (issue, hour) pairs whose stored counts must be read before sampling. */
export function groupHourKeys(prepared: Prepared[], known: KnownGroup[]): GroupHourKey[] {
  const groups = indexGroups(known);
  const keys = new Map<string, GroupHourKey>();

  for (const { event, hash } of prepared) {
    const group = groups.get(hashKey(event.projectId, hash));
    const hour = hourBucket(event.receivedAt);

    if (group !== undefined) {
      keys.set(`${group.groupId}:${hour}`, { g: group.groupId, b: hour });
    }
  }

  return [...keys.values()];
}

function collect(prepared: Prepared[], groups: Map<string, KnownGroup>): Bucket[] {
  const buckets = new Map<string, Bucket>();

  for (const item of prepared) {
    const { projectId } = item.event;
    const groupId = groups.get(hashKey(projectId, item.hash))?.groupId ?? null;
    const key = groupId === null ? `new:${hashKey(projectId, item.hash)}` : `group:${groupId}`;
    const bucket = buckets.get(key) ?? { projectId, hash: item.hash, groupId, events: [] };

    bucket.events.push({ item, hour: hourBucket(item.event.receivedAt), stored: false });
    buckets.set(key, bucket);
  }

  return [...buckets.values()];
}

type Allowance = { alreadyStored: Map<string, number>; maxPerHour: number };

function sample(bucket: Bucket, allowance: Allowance): void {
  const used = new Map<number, number>();

  bucket.events.sort((left, right) => left.item.event.timestamp - right.item.event.timestamp);

  for (const entry of bucket.events) {
    const before = allowance.alreadyStored.get(`${bucket.groupId}:${entry.hour}`) ?? 0;
    const count = used.get(entry.hour) ?? before;

    entry.stored = count < allowance.maxPerHour;
    used.set(entry.hour, entry.stored ? count + 1 : count);
  }
}

export function buildBuckets(
  prepared: Prepared[],
  state: BatchState,
  maxPerHour: number,
): Bucket[] {
  const buckets = collect(prepared, indexGroups(state.knownGroups));

  const alreadyStored = new Map(
    state.storedThisHour.map((row) => [`${row.groupId}:${row.bucket}`, row.stored]),
  );

  for (const bucket of buckets) {
    sample(bucket, { alreadyStored, maxPerHour });
  }

  return buckets;
}
