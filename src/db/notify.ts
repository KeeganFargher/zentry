// The notify consumer's reads and writes: the outbox, the records an email is
// built from, the per-issue alert interval and the per-project digest window.
// DESIGN.md §18.

import type { Level } from "@/shared/contract";
import { jsonText } from "@/shared/json";
import { MonitorRule } from "@/shared/monitor-alerts";
import type {
  AlertReason,
  IssueNotice,
  MonitorDelivery,
  OrganizationNotice,
  ProjectNotice,
} from "@/shared/notify";

import { MonitorRoutingStore } from "./monitor-routing";
import { toOutboxItem } from "./outbox";
import type { OutboxEntry, OutboxRow } from "./outbox";

export type { OutboxEntry } from "./outbox";

export type DigestWindowRow = { startedAt: number; dueAt: number };

export type PendingAlert = { groupId: number; reason: AlertReason; addedAt: number };

type IssueRow = {
  id: number;
  shortNumber: number;
  title: string;
  culprit: string;
  level: Level;
  message: string | null;
  status: IssueNotice["status"];
  timesSeen: number;
  firstSeen: number;
  lastSeen: number;
  lastEventId: string | null;
  projectId: number;
  projectSlug: string;
  projectName: string;
  organizationId: number;
  organizationSlug: string;
  organizationName: string;
};

const ISSUE_NOTICE = `
  SELECT g.id, g.short_id AS shortNumber, g.title, g.culprit, g.level,
         json_extract(g.metadata, '$.value') AS message, g.status,
         g.times_seen AS timesSeen, g.first_seen AS firstSeen, g.last_seen AS lastSeen,
         g.last_event_id AS lastEventId,
         p.id AS projectId, p.slug AS projectSlug, p.name AS projectName,
         o.id AS organizationId, o.slug AS organizationSlug, o.name AS organizationName
  FROM groups g
  JOIN projects p ON p.id = g.project_id
  JOIN organizations o ON o.id = p.organization_id`;

function toIssue(row: IssueRow): IssueNotice {
  return {
    id: row.id,
    shortId: `${row.projectSlug.toUpperCase()}-${row.shortNumber}`,
    title: row.title,
    culprit: row.culprit,
    level: row.level,
    message: row.message,
    status: row.status,
    timesSeen: row.timesSeen,
    firstSeen: row.firstSeen,
    lastSeen: row.lastSeen,
    lastEventId: row.lastEventId,
    project: {
      id: row.projectId,
      slug: row.projectSlug,
      name: row.projectName,
      organization: {
        id: row.organizationId,
        slug: row.organizationSlug,
        name: row.organizationName,
      },
    },
  };
}

export class NotifyStore {
  readonly #db: D1Database;

  readonly monitorRouting: MonitorRoutingStore;

  constructor(db: D1Database) {
    this.#db = db;
    this.monitorRouting = new MonitorRoutingStore(db);
  }

  /** The oldest unhandled rows. */
  /** The oldest rows not stepped aside by a deferral. */
  async outbox(limit: number, now: number): Promise<OutboxEntry[]> {
    const { results } = await this.#db
      .prepare(
        `SELECT id, kind, organization_id, project_id, group_id, actor_id, data, attempts
         FROM notify_outbox WHERE deferred_until <= ?2 ORDER BY id LIMIT ?1`,
      )
      .bind(limit, now)
      .all<OutboxRow>();

    return results.map((row) => ({ item: toOutboxItem(row), attempts: row.attempts }));
  }

  async failed(id: number): Promise<void> {
    await this.#db
      .prepare(`UPDATE notify_outbox SET attempts = attempts + 1 WHERE id = ?1`)
      .bind(id)
      .run();
  }

  /** A provider asked to wait: the row steps aside until `until`, with no attempt counted. */
  async deferred(id: number, until: number): Promise<void> {
    await this.#db
      .prepare(`UPDATE notify_outbox SET deferred_until = ?2 WHERE id = ?1`)
      .bind(id, until)
      .run();
  }

  async handled(id: number): Promise<void> {
    await this.#db.prepare(`DELETE FROM notify_outbox WHERE id = ?1`).bind(id).run();
  }

  async monitorDelivery(id: number, time: number): Promise<MonitorDelivery | null> {
    const row = await this.#db
      .prepare(`SELECT d.id, d.group_id AS groupId, r.id AS ruleId, d.channel,
      d.transition_type AS transition, m.id AS monitorId, m.owner_id AS ownerId,
      COALESCE(NULLIF(t.scope,''), json_extract(m.config,'$.environment'), '') AS environment, t.period_id AS periodId, r.config,
      CASE WHEN m.type = 'metric' AND json_extract(m.config,'$.comparator') IN ('lt','lte') THEN 1 ELSE 0 END AS belowCount
      FROM monitor_deliveries d JOIN monitor_transitions t ON t.id = d.transition_id
      JOIN monitor_alert_rules r ON r.id = d.rule_id JOIN monitors m ON m.id = t.monitor_id
      WHERE d.id = ?1 AND d.suppression IS NULL AND m.status = 'active' AND m.notify = 1 AND t.generation = m.generation
        AND COALESCE(m.muted_until,0) <= ?2 AND json_extract(r.config,'$.enabled') = 1
        AND r.id IN (SELECT value FROM json_each(m.alert_rule_ids))
        AND d.channel IN (SELECT value FROM json_each(r.config,'$.channels'))
        AND d.transition_type IN (SELECT value FROM json_each(r.config,'$.triggers'))
        AND (json_extract(r.config,'$.environment') IS NULL OR json_extract(r.config,'$.environment') = COALESCE(NULLIF(t.scope,''),json_extract(m.config,'$.environment')))
        AND (json_extract(r.config,'$.priority') IS NULL OR json_extract(t.evidence,'$.severity') = 'high')`)
      .bind(id, time)
      .first<Omit<MonitorDelivery, "audience"> & { config: string }>();

    if (row === null) {
      return null;
    }

    const { config, ...delivery } = row;
    const { audience } = jsonText(MonitorRule.omit({ name: true })).parse(config);

    return { ...delivery, audience };
  }

  async suppressMonitorDelivery(id: number, reason: string): Promise<void> {
    await this.#db
      .prepare(
        "UPDATE monitor_deliveries SET suppression = ?2 WHERE id = ?1 AND suppression IS NULL",
      )
      .bind(id, reason)
      .run();
  }

  async monitorRecoveryAudience(delivery: MonitorDelivery): Promise<Set<number>> {
    const { results } = await this.#db
      .prepare(`
      SELECT DISTINCT sends.user_id AS userId FROM monitor_deliveries prior
      JOIN monitor_transitions transition ON transition.id = prior.transition_id
      JOIN email_sends sends ON sends.key = 'monitor:' || prior.id || ':' || sends.user_id
      WHERE prior.group_id = ?1 AND prior.rule_id = ?2 AND prior.transition_type IN ('failure','escalation')
        AND prior.channel = ?4 AND sends.status = 'sent' AND transition.period_id = ?3
      UNION
      SELECT DISTINCT devices.user_id AS userId FROM monitor_deliveries prior
      JOIN monitor_transitions transition ON transition.id = prior.transition_id
      JOIN devices JOIN push_sends sends ON sends.key = 'monitor:' || prior.id || ':' || devices.user_id || ':' || devices.id
      WHERE prior.group_id = ?1 AND prior.rule_id = ?2 AND prior.transition_type IN ('failure','escalation')
        AND prior.channel = ?4 AND sends.status IN ('sent','delivered') AND transition.period_id = ?3`)
      .bind(delivery.groupId, delivery.ruleId, delivery.periodId, delivery.channel)
      .all<{ userId: number }>();

    return new Set(results.map(({ userId }) => userId));
  }

  async issues(groupIds: number[]): Promise<IssueNotice[]> {
    const { results } = await this.#db
      .prepare(`${ISSUE_NOTICE} WHERE g.id IN (SELECT value FROM json_each(?1))`)
      .bind(JSON.stringify(groupIds))
      .all<IssueRow>();

    return results.map(toIssue);
  }

  async project(projectId: number): Promise<ProjectNotice | null> {
    const row = await this.#db
      .prepare(
        `SELECT p.id, p.slug, p.name, o.id AS organizationId, o.slug AS organizationSlug,
                o.name AS organizationName
         FROM projects p JOIN organizations o ON o.id = p.organization_id WHERE p.id = ?1`,
      )
      .bind(projectId)
      .first<{
        id: number;
        slug: string;
        name: string;
        organizationId: number;
        organizationSlug: string;
        organizationName: string;
      }>();

    return row === null
      ? null
      : {
          id: row.id,
          slug: row.slug,
          name: row.name,
          organization: {
            id: row.organizationId,
            slug: row.organizationSlug,
            name: row.organizationName,
          },
        };
  }

  async organization(organizationId: number): Promise<OrganizationNotice | null> {
    return this.#db
      .prepare(`SELECT id, slug, name FROM organizations WHERE id = ?1`)
      .bind(organizationId)
      .first<OrganizationNotice>();
  }

  async userEmail(userId: number): Promise<string | null> {
    const row = await this.#db
      .prepare(`SELECT email FROM users WHERE id = ?1`)
      .bind(userId)
      .first<{ email: string }>();

    return row?.email ?? null;
  }

  async lastAlert(groupId: number, reason: AlertReason): Promise<number | null> {
    const row = await this.#db
      .prepare(`SELECT last_sent FROM notify_state WHERE group_id = ?1 AND reason = ?2`)
      .bind(groupId, reason)
      .first<{ last_sent: number }>();

    return row?.last_sent ?? null;
  }

  async recordAlert(groupId: number, reason: AlertReason, now: number): Promise<void> {
    await this.#db
      .prepare(
        `INSERT INTO notify_state (group_id, reason, last_sent) VALUES (?1, ?2, ?3)
         ON CONFLICT (group_id, reason) DO UPDATE SET last_sent = excluded.last_sent`,
      )
      .bind(groupId, reason, now)
      .run();
  }

  async digestWindow(projectId: number): Promise<DigestWindowRow | null> {
    return this.#db
      .prepare(
        `SELECT started_at AS startedAt, due_at AS dueAt FROM digest_windows WHERE project_id = ?1`,
      )
      .bind(projectId)
      .first<DigestWindowRow>();
  }

  async saveDigestWindow(projectId: number, window: DigestWindowRow): Promise<void> {
    await this.#db
      .prepare(
        `INSERT INTO digest_windows (project_id, started_at, due_at) VALUES (?1, ?2, ?3)
         ON CONFLICT (project_id) DO UPDATE SET started_at = excluded.started_at, due_at = excluded.due_at`,
      )
      .bind(projectId, window.startedAt, window.dueAt)
      .run();
  }

  /** A second alert for an issue already waiting keeps the first. */
  async holdAlert(projectId: number, alert: PendingAlert): Promise<void> {
    await this.#db
      .prepare(
        `INSERT OR IGNORE INTO digest_pending (project_id, group_id, reason, added_at)
         VALUES (?1, ?2, ?3, ?4)`,
      )
      .bind(projectId, alert.groupId, alert.reason, alert.addedAt)
      .run();
  }

  async heldAlerts(projectId: number): Promise<PendingAlert[]> {
    const { results } = await this.#db
      .prepare(
        `SELECT group_id AS groupId, reason, added_at AS addedAt FROM digest_pending
         WHERE project_id = ?1 ORDER BY added_at, group_id`,
      )
      .bind(projectId)
      .all<PendingAlert>();

    return results;
  }

  /** Clears the held alerts and starts the next window at once. */
  async restartDigest(projectId: number, next: DigestWindowRow): Promise<void> {
    const db = this.#db;

    await db.batch([
      db.prepare(`DELETE FROM digest_pending WHERE project_id = ?1`).bind(projectId),
      db
        .prepare(`UPDATE digest_windows SET started_at = ?2, due_at = ?3 WHERE project_id = ?1`)
        .bind(projectId, next.startedAt, next.dueAt),
    ]);
  }

  /** Ends a window that is due with nothing held: the next alert goes out at once. */
  async closeDigest(projectId: number): Promise<void> {
    const db = this.#db;

    await db.batch([
      db.prepare(`DELETE FROM digest_pending WHERE project_id = ?1`).bind(projectId),
      db.prepare(`DELETE FROM digest_windows WHERE project_id = ?1`).bind(projectId),
    ]);
  }

  /** One outbox row per organization, for the weekly report. */
  async queueWeeklyReports(range: { start: number; end: number }, now: number): Promise<number> {
    const result = await this.#db
      .prepare(
        `INSERT INTO notify_outbox (kind, organization_id, data, created_at)
         SELECT 'weekly_report', id, json_object('start', ?1, 'end', ?2), ?3 FROM organizations`,
      )
      .bind(range.start, range.end, now)
      .run();

    return result.meta.changes;
  }

  /** Projects whose digest window is past due by `grace`: its flush was lost. */
  async overdueDigests(now: number, grace: number): Promise<number[]> {
    const { results } = await this.#db
      .prepare(`SELECT project_id FROM digest_windows WHERE due_at < ?1 ORDER BY project_id`)
      .bind(now - grace)
      .all<{ project_id: number }>();

    return results.map((row) => row.project_id);
  }

  /** Rows the consumer has not yet handled, for the hourly sweep. */
  async outboxSize(): Promise<number> {
    const row = await this.#db
      .prepare(`SELECT count(*) AS n FROM notify_outbox`)
      .first<{ n: number }>();

    return row?.n ?? 0;
  }
}
