// Everything the queue consumer reads and writes. DESIGN.md §7.4: steps B
// (read) and E (commit). Every bulk statement takes one JSON array parameter
// and expands it with json_each, which keeps it inside D1's 100-parameter
// limit whatever the batch size.

import type { IssueStatus } from "@/shared/contract";
import type {
  BatchState,
  BatchWrites,
  EventKey,
  GroupHourKey,
  GroupHourStored,
  HashKey,
  KnownGroup,
  NewGroupRow,
  ProjectQuota,
} from "@/shared/plan";
import { GROUPING_CONFIG } from "@/shared/types";

type GroupRow = {
  project_id: number;
  hash: string;
  group_id: number;
  status: IssueStatus;
  resolved_at: number | null;
};

type QuotaRow = {
  id: number;
  max_events_per_hour: number | null;
  spike_limit: number | null;
  received: number;
};

type StoredRow = { group_id: number; bucket: number; stored: number };

export type BatchKeys = {
  events: EventKey[];
  hashes: HashKey[];
  projectIds: number[];
  hour: number;
};

const SELECT_EXISTING_EVENTS = `
  SELECT e.project_id AS p, e.event_id AS e
  FROM json_each(?1) j
  JOIN events e ON e.project_id = j.value->>'p' AND e.event_id = j.value->>'e'`;

const SELECT_KNOWN_GROUPS = `
  SELECT gh.project_id, gh.hash, g.id AS group_id, g.status, g.resolved_at
  FROM json_each(?1) j
  JOIN grouphashes gh ON gh.project_id = j.value->>'p' AND gh.hash = j.value->>'h'
  JOIN groups g ON g.id = gh.group_id`;

const SELECT_QUOTAS = `
  SELECT p.id, p.max_events_per_hour,
         CASE WHEN p.spike_protection = 1 THEN p.spike_limit_per_hour END AS spike_limit,
         COALESCE(ps.received, 0) AS received
  FROM json_each(?1) j
  JOIN projects p ON p.id = j.value
  LEFT JOIN project_stats ps ON ps.project_id = p.id AND ps.bucket = ?2`;

const SELECT_STORED = `
  SELECT s.group_id, s.bucket, s.stored
  FROM json_each(?1) j
  JOIN group_stats s ON s.group_id = j.value->>'g' AND s.bucket = j.value->>'b'`;

// E1. The short id is taken from the project row inside the transaction.
const INSERT_GROUP = `
  INSERT INTO groups
    (project_id, short_id, primary_hash, title, culprit, level, platform, metadata,
     status, substatus, times_seen, first_seen, last_seen, last_event_id, first_release, created_at)
  SELECT ?1, p.next_short_id + 1, ?2, ?3, ?4, ?5, ?6, ?7,
         'unresolved', NULL, 0, ?8, ?8, ?9, ?10, ?11
  FROM projects p WHERE p.id = ?1`;

const BUMP_SHORT_ID = `
  UPDATE projects
  SET next_short_id = next_short_id + 1,
      first_event_at = COALESCE(first_event_at, ?2)
  WHERE id = ?1`;

const INSERT_GROUPHASH = `
  INSERT INTO grouphashes (project_id, hash, group_id, grouping_config, created_at)
  SELECT ?1, ?2, g.id, ?3, ?4 FROM groups g WHERE g.project_id = ?1 AND g.primary_hash = ?2`;

// E2. Must run before E3, which clears the resolved state it looks for.
const INSERT_REGRESSIONS = `
  INSERT INTO activity (group_id, project_id, type, user_id, data, created_at)
  SELECT g.id, g.project_id, 'regressed', NULL, json_object('event_id', j.value->>'eid'), ?2
  FROM json_each(?1) j
  JOIN grouphashes gh ON gh.project_id = j.value->>'p' AND gh.hash = j.value->>'h'
  JOIN groups g ON g.id = gh.group_id
  WHERE g.status = 'resolved' AND j.value->>'last_received' > COALESCE(g.resolved_at, 0)`;

// E3. Every right-hand side sees the row as it was before the update.
const UPDATE_GROUPS = `
  UPDATE groups SET
    times_seen    = groups.times_seen + j.n,
    first_seen    = min(groups.first_seen, j.first_ts),
    last_seen     = max(groups.last_seen, j.last_ts),
    last_event_id = CASE WHEN j.last_ts >= groups.last_seen AND j.eid IS NOT NULL
                         THEN j.eid ELSE groups.last_event_id END,
    title         = CASE WHEN j.last_ts >= groups.last_seen AND j.title NOT LIKE '<%'
                         THEN j.title ELSE groups.title END,
    culprit       = CASE WHEN j.last_ts >= groups.last_seen THEN j.culprit ELSE groups.culprit END,
    level         = CASE WHEN j.last_ts >= groups.last_seen THEN j.level ELSE groups.level END,
    metadata      = CASE WHEN j.last_ts >= groups.last_seen THEN j.metadata ELSE groups.metadata END,
    substatus     = CASE WHEN groups.status = 'resolved' AND j.last_received > COALESCE(groups.resolved_at, 0)
                         THEN 'regressed' ELSE groups.substatus END,
    status        = CASE WHEN groups.status = 'resolved' AND j.last_received > COALESCE(groups.resolved_at, 0)
                         THEN 'unresolved' ELSE groups.status END
  FROM (
    SELECT gh.group_id AS gid,
           value->>'n' AS n, value->>'first_ts' AS first_ts, value->>'last_ts' AS last_ts,
           value->>'last_received' AS last_received, value->>'eid' AS eid,
           value->>'title' AS title, value->>'culprit' AS culprit,
           value->>'level' AS level, value->>'metadata' AS metadata
    FROM json_each(?1)
    JOIN grouphashes gh ON gh.project_id = value->>'p' AND gh.hash = value->>'h'
  ) AS j
  WHERE groups.id = j.gid`;

// E4. A plain INSERT: a duplicate key aborts the transaction (the backstop in §7.1).
const INSERT_EVENTS = `
  INSERT INTO events
    (project_id, event_id, group_id, ts, received_at, level, platform,
     release, environment, user_label, title, size_bytes)
  SELECT value->>'p', value->>'e', gh.group_id, value->>'ts', value->>'rx', value->>'level',
         value->>'platform', value->>'release', value->>'env', value->>'user', value->>'title', value->>'size'
  FROM json_each(?1)
  JOIN grouphashes gh ON gh.project_id = value->>'p' AND gh.hash = value->>'h'`;

// E5 to E7. "WHERE true" is required before ON CONFLICT when the source is a SELECT.
const UPSERT_GROUP_STATS = `
  INSERT INTO group_stats (group_id, bucket, project_id, count, stored)
  SELECT gh.group_id, value->>'b', value->>'p', value->>'n', value->>'stored'
  FROM json_each(?1)
  JOIN grouphashes gh ON gh.project_id = value->>'p' AND gh.hash = value->>'h'
  WHERE true
  ON CONFLICT(group_id, bucket) DO UPDATE SET
    count = count + excluded.count, stored = stored + excluded.stored`;

const UPSERT_TAGS = `
  INSERT INTO group_tag_values (group_id, key, value, project_id, times_seen, first_seen, last_seen)
  SELECT gh.group_id, j.value->>'k', j.value->>'v', j.value->>'p', j.value->>'n', j.value->>'ts', j.value->>'ts'
  FROM json_each(?1) j
  JOIN grouphashes gh ON gh.project_id = j.value->>'p' AND gh.hash = j.value->>'h'
  WHERE true
  ON CONFLICT(group_id, key, value) DO UPDATE SET
    times_seen = times_seen + excluded.times_seen,
    last_seen  = max(last_seen, excluded.last_seen)`;

const UPSERT_PROJECT_STATS = `
  INSERT INTO project_stats (project_id, bucket, received, stored)
  SELECT value->>'p', value->>'b', value->>'n', value->>'stored' FROM json_each(?1)
  WHERE EXISTS (SELECT 1 FROM projects WHERE id = value->>'p')
  ON CONFLICT(project_id, bucket) DO UPDATE SET
    received = received + excluded.received, stored = stored + excluded.stored`;

// E8.
const SET_RATE_LIMIT = `
  UPDATE projects SET rate_limited_until = ?2, rate_limit_reason = ?3 WHERE id = ?1`;

// E9. Counted from project_stats rows, so an event for a deleted project, which
// E7 skips, still counts here: it was accepted at ingest all the same.
const UPSERT_USAGE = `
  INSERT INTO usage_months (month, received)
  SELECT value->>'m', value->>'n' FROM json_each(?1)
  WHERE true
  ON CONFLICT(month) DO UPDATE SET received = received + excluded.received`;

export class BatchStore {
  readonly #db: D1Database;

  constructor(db: D1Database) {
    this.#db = db;
  }

  /** B1, B2 and B4. `storedThisHour` is filled by `readStored` once group ids are known. */
  async readState(keys: BatchKeys): Promise<BatchState> {
    const db = this.#db;

    const [existing, groups, quotas] = await Promise.all([
      db.prepare(SELECT_EXISTING_EVENTS).bind(JSON.stringify(keys.events)).all<EventKey>(),
      db.prepare(SELECT_KNOWN_GROUPS).bind(JSON.stringify(keys.hashes)).all<GroupRow>(),
      db.prepare(SELECT_QUOTAS).bind(JSON.stringify(keys.projectIds), keys.hour).all<QuotaRow>(),
    ]);

    return {
      existingEvents: existing.results,
      knownGroups: groups.results.map((row): KnownGroup => ({
        projectId: row.project_id,
        hash: row.hash,
        groupId: row.group_id,
        status: row.status,
        resolvedAt: row.resolved_at,
      })),
      storedThisHour: [],
      quotas: quotas.results.map((row): ProjectQuota => ({
        projectId: row.id,
        maxEventsPerHour: row.max_events_per_hour,
        spikeLimitPerHour: row.spike_limit,
        received: row.received,
      })),
    };
  }

  /** B3. */
  async readStored(keys: GroupHourKey[]): Promise<GroupHourStored[]> {
    if (keys.length === 0) {
      return [];
    }

    const { results } = await this.#db
      .prepare(SELECT_STORED)
      .bind(JSON.stringify(keys))
      .all<StoredRow>();

    return results.map((row) => ({
      groupId: row.group_id,
      bucket: row.bucket,
      stored: row.stored,
    }));
  }

  /** E1 to E9, as one transaction. */
  async commit(writes: BatchWrites, now: number): Promise<void> {
    const db = this.#db;
    const aggregates = JSON.stringify(writes.aggregates);

    const statements = [
      ...writes.newGroups.flatMap((row) => this.#newGroupStatements(row, now)),
      db.prepare(INSERT_REGRESSIONS).bind(aggregates, now),
      db.prepare(UPDATE_GROUPS).bind(aggregates),
      db.prepare(INSERT_EVENTS).bind(JSON.stringify(writes.events)),
      db.prepare(UPSERT_GROUP_STATS).bind(JSON.stringify(writes.groupStats)),
      db.prepare(UPSERT_TAGS).bind(JSON.stringify(writes.tags)),
      db.prepare(UPSERT_PROJECT_STATS).bind(JSON.stringify(writes.projectStats)),
      ...writes.limits.map((row) => db.prepare(SET_RATE_LIMIT).bind(row.p, row.until, row.reason)),
      db.prepare(UPSERT_USAGE).bind(JSON.stringify(writes.usage)),
    ];

    await db.batch(statements);
  }

  #newGroupStatements(row: NewGroupRow, now: number): D1PreparedStatement[] {
    const db = this.#db;

    return [
      db
        .prepare(INSERT_GROUP)
        .bind(
          row.p,
          row.h,
          row.title,
          row.culprit,
          row.level,
          row.platform,
          row.metadata,
          row.first_ts,
          row.eid,
          row.release,
          now,
        ),
      db.prepare(BUMP_SHORT_ID).bind(row.p, now),
      db.prepare(INSERT_GROUPHASH).bind(row.p, row.h, GROUPING_CONFIG, now),
    ];
  }
}
