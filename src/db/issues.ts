// Issue queries for the read API. Every query is scoped to an organization.

import { z } from "zod";

import type { ApiActivity, ApiIssue, IssueMetadata, IssueStatus, Pair } from "@/shared/contract";
import { jsonText } from "@/shared/json";

export type IssueRecord = Omit<ApiIssue, "stats" | "hasSeen">;

export type IssueSort = "date" | "new" | "freq";

export type IssueCursor = { value: number; id: number };

export type IssueFilter = {
  organizationId: number;
  projectId: number | null;
  status: IssueStatus | null;
  level: string | null;
  query: string | null;
  tag: Pair | null;
  sort: IssueSort;
  cursor: IssueCursor | null;
  limit: number;
};

export type StatusChange = {
  organizationId: number;
  issueIds: number[];
  status: IssueStatus;
  userId: number;
  now: number;
};

/** Which of a project's issues a bulk change applies to. Null means no filter. */
export type ProjectSelection = {
  projectId: number;
  ids: number[] | null;
  status: IssueStatus | null;
  /** The status being set: issues already there are not counted or changed. */
  target: IssueStatus;
  limit: number;
};

export type IssueHour = { groupId: number; bucket: number; count: number; stored: number };

export type TagCount = { key: string; value: string; count: number; total: number };

type IssueRow = Omit<IssueRecord, "metadata" | "shortId" | "monitorId"> & {
  monitorId: string | null;
  metadata: string;
  shortNumber: number;
};

type Bind = string | number;

type Conditions = { clauses: string[]; binds: Bind[] };

const SORT_COLUMNS = {
  date: "g.last_seen",
  new: "g.first_seen",
  freq: "g.times_seen",
} satisfies { [sort in IssueSort]: string };

const ISSUE_COLUMNS = `
  SELECT g.id, g.monitor_id AS monitorId, g.short_id AS shortNumber, g.project_id AS projectId, p.slug AS projectSlug,
         g.title, g.culprit, g.level, g.platform, g.metadata, g.status, g.substatus,
         g.times_seen AS timesSeen, g.first_seen AS firstSeen, g.last_seen AS lastSeen,
         g.resolved_at AS resolvedAt, g.last_event_id AS lastEventId, g.first_release AS firstRelease`;

const SELECT_ISSUES = `${ISSUE_COLUMNS} FROM groups g JOIN projects p ON p.id = g.project_id`;

// With a tag filter the list starts from the tag index, so a rare value reads
// only its few issues; the price is sorting those in memory. CROSS JOIN makes
// SQLite keep this order instead of walking every issue by date and probing the
// index for each one. The two binds are the tag's key and value.
const SELECT_TAGGED_ISSUES = `${ISSUE_COLUMNS} FROM projects p
  CROSS JOIN group_tag_values t ON t.project_id = p.id AND t.key = ? AND t.value = ?
  CROSS JOIN groups g ON g.id = t.group_id`;

const IN_ORGANIZATION = `project_id IN (SELECT id FROM projects WHERE organization_id = ?2)`;

// Written by the consumer from `deriveMetadata`, so it must match exactly. A
// row that does not is corrupt, and parsing throws rather than showing an
// issue with silently blanked fields.
const Metadata = jsonText(
  z.object({
    type: z.string().nullable(),
    value: z.string().nullable(),
    filename: z.string().nullable(),
    function: z.string().nullable(),
    logger: z.string().nullable(),
  }),
) satisfies z.ZodType<IssueMetadata, string>;

function toRecord({ metadata, shortNumber, monitorId, ...row }: IssueRow): IssueRecord {
  const issue = {
    ...row,
    shortId: `${row.projectSlug.toUpperCase()}-${shortNumber}`,
    metadata: Metadata.parse(metadata),
  };

  return monitorId === null ? issue : { ...issue, monitorId };
}

function escapeLike(text: string): string {
  return text.replaceAll(/[\\%_]/g, (character) => `\\${character}`);
}

/** Builds the WHERE clause for the issue list. Binds are positional. */
function listConditions(filter: IssueFilter): Conditions {
  const clauses = ["p.organization_id = ?"];
  const binds: Bind[] = [filter.organizationId];

  const add = (clause: string, ...values: Bind[]): void => {
    clauses.push(clause);
    binds.push(...values);
  };

  if (filter.projectId !== null) {
    add("g.project_id = ?", filter.projectId);
  }

  if (filter.status !== null) {
    add("g.status = ?", filter.status);
  }

  if (filter.level !== null) {
    add("g.level = ?", filter.level);
  }

  if (filter.query !== null) {
    const pattern = `%${escapeLike(filter.query)}%`;

    add(`(g.title LIKE ? ESCAPE '\\' OR g.culprit LIKE ? ESCAPE '\\')`, pattern, pattern);
  }

  if (filter.cursor !== null) {
    add(`(${SORT_COLUMNS[filter.sort]}, g.id) < (?, ?)`, filter.cursor.value, filter.cursor.id);
  }

  return { clauses, binds };
}

export class IssueStore {
  readonly #db: D1Database;

  constructor(db: D1Database) {
    this.#db = db;
  }

  async list(filter: IssueFilter): Promise<IssueRecord[]> {
    const { clauses, binds } = listConditions(filter);
    const column = SORT_COLUMNS[filter.sort];
    const from = filter.tag === null ? SELECT_ISSUES : SELECT_TAGGED_ISSUES;
    const tagBinds = filter.tag ?? [];

    const { results } = await this.#db
      .prepare(
        `${from} WHERE ${clauses.join(" AND ")}
         ORDER BY ${column} DESC, g.id DESC LIMIT ?`,
      )
      .bind(...tagBinds, ...binds, filter.limit)
      .all<IssueRow>();

    return results.map(toRecord);
  }

  async find(organizationId: number, issueId: number): Promise<IssueRecord | null> {
    const row = await this.#db
      .prepare(`${SELECT_ISSUES} WHERE g.id = ?1 AND p.organization_id = ?2`)
      .bind(issueId, organizationId)
      .first<IssueRow>();

    return row === null ? null : toRecord(row);
  }

  /**
   * The ids of a project's issues that a bulk status change from sentry-cli
   * would change: those named in `ids` (or all), with `status` (or any), and
   * not already at `target`. Monitor issues are left out, as setStatus would
   * skip them. Reads at most `limit` ids, so the caller can tell when more
   * matched than it will change.
   */
  async projectIssueIds(selection: ProjectSelection): Promise<number[]> {
    const { results } = await this.#db
      .prepare(
        `SELECT id FROM groups
         WHERE project_id = ?1 AND monitor_id IS NULL AND status != ?4
           AND (?2 IS NULL OR id IN (SELECT value FROM json_each(?2)))
           AND (?3 IS NULL OR status = ?3)
         ORDER BY id LIMIT ?5`,
      )
      .bind(
        selection.projectId,
        selection.ids === null ? null : JSON.stringify(selection.ids),
        selection.status,
        selection.target,
        selection.limit,
      )
      .all<{ id: number }>();

    return results.map((row) => row.id);
  }

  /**
   * Which of `ids` are the project's own issues that a person may change
   * (not a monitor's), so a bulk change can refuse the rest by name.
   */
  async changeableIn(projectId: number, ids: number[]): Promise<Set<number>> {
    const { results } = await this.#db
      .prepare(
        `SELECT id FROM groups WHERE project_id = ?1 AND monitor_id IS NULL
           AND id IN (SELECT value FROM json_each(?2))`,
      )
      .bind(projectId, JSON.stringify(ids))
      .all<{ id: number }>();

    return new Set(results.map((row) => row.id));
  }

  /** Resolves `API-42`: project slug (any case) and the per-project number. */
  async findByShortId(
    organizationId: number,
    slug: string,
    shortNumber: number,
  ): Promise<IssueRecord | null> {
    const row = await this.#db
      .prepare(
        `${SELECT_ISSUES}
         WHERE p.organization_id = ?1 AND lower(p.slug) = lower(?2) AND g.short_id = ?3`,
      )
      .bind(organizationId, slug, shortNumber)
      .first<IssueRow>();

    return row === null ? null : toRecord(row);
  }

  /**
   * Changes status and records an activity row for each issue that changed,
   * with an outbox row for its workflow email (DESIGN.md §18). The user who
   * made the change follows the issue from then on, unless they unfollowed
   * it. Returns how many issues changed.
   */
  async setStatus(change: StatusChange): Promise<number> {
    const db = this.#db;
    const ids = JSON.stringify(change.issueIds);
    const changed = `id IN (SELECT value FROM json_each(?1)) AND ${IN_ORGANIZATION} AND status != ?3 AND monitor_id IS NULL`;
    const binds = [ids, change.organizationId, change.status, change.userId, change.now];

    const results = await db.batch([
      db
        .prepare(
          `INSERT INTO activity (group_id, project_id, type, user_id, data, created_at)
           SELECT id, project_id, ?3, ?4, '{}', ?5 FROM groups WHERE ${changed}`,
        )
        .bind(...binds),
      db
        .prepare(
          `INSERT INTO notify_outbox (kind, organization_id, project_id, group_id, actor_id, data, created_at)
           SELECT 'status', ?2, project_id, id, ?4, json_object('status', ?3), ?5 FROM groups WHERE ${changed}`,
        )
        .bind(...binds),
      db
        .prepare(
          `INSERT OR IGNORE INTO issue_subscriptions (user_id, group_id, active, reason, created_at)
           SELECT ?4, id, 1, 'status_change', ?5 FROM groups WHERE ${changed}`,
        )
        .bind(...binds),
      db
        .prepare(
          `UPDATE groups SET
             status = ?3,
             -- Only resolving ends a regression; ignoring a regressed issue
             -- keeps the mark, so it still reads as regressed if reopened.
             substatus = CASE WHEN ?3 = 'resolved' THEN NULL ELSE substatus END,
             resolved_at = CASE WHEN ?3 = 'resolved' THEN ?5 ELSE NULL END,
             resolved_by = CASE WHEN ?3 = 'resolved' THEN ?4 ELSE NULL END
           WHERE ${changed}`,
        )
        .bind(...binds),
    ]);

    return results[0]?.meta.changes ?? 0;
  }

  /** Records that the user opened the issue now. */
  async markSeen(userId: number, issue: IssueRecord, now: number): Promise<void> {
    await this.#db
      .prepare(
        `INSERT INTO group_seen (user_id, group_id, project_id, last_seen) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(user_id, group_id) DO UPDATE SET last_seen = excluded.last_seen`,
      )
      .bind(userId, issue.id, issue.projectId, now)
      .run();
  }

  /**
   * Which of these issues the user has opened since each last became active:
   * since it was first seen, or since its latest regression.
   */
  async seenBy(userId: number, issueIds: number[]): Promise<Set<number>> {
    const { results } = await this.#db
      .prepare(
        `SELECT g.id FROM groups g
         JOIN group_seen s ON s.group_id = g.id AND s.user_id = ?1
         WHERE g.id IN (SELECT value FROM json_each(?2))
           AND s.last_seen > COALESCE(
             (SELECT MAX(a.created_at) FROM activity a
              WHERE a.group_id = g.id AND a.type = 'regressed'),
             g.first_seen)`,
      )
      .bind(userId, JSON.stringify(issueIds))
      .all<{ id: number }>();

    return new Set(results.map((row) => row.id));
  }

  /** Cascades to the issue's hashes, events, tags, stats, activity and seen marks. */
  async delete(organizationId: number, issueId: number): Promise<void> {
    await this.#db
      .prepare(`DELETE FROM groups WHERE id = ?1 AND ${IN_ORGANIZATION} AND monitor_id IS NULL`)
      .bind(issueId, organizationId)
      .run();
  }

  async hourlyCounts(issueIds: number[], since: number): Promise<IssueHour[]> {
    const { results } = await this.#db
      .prepare(
        `SELECT group_id AS groupId, bucket, count, stored FROM group_stats
         WHERE group_id IN (SELECT value FROM json_each(?1)) AND bucket >= ?2`,
      )
      .bind(JSON.stringify(issueIds), since)
      .all<IssueHour>();

    return results;
  }

  /** The top `perKey` values of every tag key, with the key's total. */
  async topTags(issueId: number, perKey: number): Promise<TagCount[]> {
    const { results } = await this.#db
      .prepare(
        `SELECT key, value, count, total FROM (
           SELECT key, value, times_seen AS count,
                  SUM(times_seen) OVER (PARTITION BY key) AS total,
                  ROW_NUMBER() OVER (PARTITION BY key ORDER BY times_seen DESC, value) AS position
           FROM group_tag_values WHERE group_id = ?1
         ) WHERE position <= ?2 ORDER BY key, count DESC, value`,
      )
      .bind(issueId, perKey)
      .all<TagCount>();

    return results;
  }

  async activity(issueId: number): Promise<ApiActivity[]> {
    const { results } = await this.#db
      .prepare(
        `SELECT a.id, a.type, u.email AS userEmail, a.created_at AS createdAt
         FROM activity a LEFT JOIN users u ON u.id = a.user_id
         WHERE a.group_id = ?1 ORDER BY a.created_at DESC, a.id DESC LIMIT 100`,
      )
      .bind(issueId)
      .all<ApiActivity>();

    return results;
  }
}
