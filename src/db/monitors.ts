import { z } from "zod";

import { jsonText } from "@/shared/json";
import {
  CreateMonitor,
  Creator,
  LastIssue,
  MAX_MONITORS_PER_ORGANIZATION,
  MonitorFields,
} from "@/shared/monitors";
import type { ApiMonitor, NewMonitor } from "@/shared/monitors";
import { DAY, HOUR } from "@/shared/time";

import { previewMetricQuery } from "./metric-query";
import { invalidationStatements } from "./monitor-issues";
import { MonitorTimeline } from "./monitor-timeline";

const Row = MonitorFields.extend({
  projectId: z.int().positive(),
  name: z.string(),
  description: z.string(),
  ownerId: z.int().nullable(),
  alertRuleIds: jsonText(z.array(z.uuid())),
  notify: z.union([z.literal(0), z.literal(1)]).transform(Boolean),
  type: z.string(),
  config: jsonText(z.json()),
  lastIssue: jsonText(LastIssue).nullable(),
  creator: jsonText(Creator),
}).transform(
  ({
    projectId,
    name,
    type,
    config,
    notify,
    description,
    ownerId,
    alertRuleIds,
    ...metadata
  }): ApiMonitor => ({
    ...CreateMonitor.parse({
      projectId,
      name,
      type,
      config,
      notify,
      description,
      ownerId,
      alertRuleIds,
    }),
    ...metadata,
  }),
);

// Retention, from the plan: 14 days of observations and metric rollups, 30
// days of check-ins, and 90 days of incidents, deliveries and audit.
const HISTORY = 14 * DAY;
const CHECK_IN_HISTORY = 30 * DAY;
const INCIDENT_HISTORY = 90 * DAY;
const PRUNE_BATCH = 5000;

type Actor = { userId: number; time: number };

/**
 * A cron monitor's next expected check-in, counted from the change so a new or
 * resumed schedule cannot miss slots retroactively. Null when there is nothing
 * to re-plan: metric and uptime monitors, and cron edits that keep the timing.
 */
export type CronReplan = { nextCheckIn: number; nextCheckInLatest: number } | null;

type Control = Actor & { version: number };

type CreateIdentity = Actor & { requestKey: string | null };

const COLUMNS =
  "id, project_id AS projectId, name, description, owner_id AS ownerId, muted_until AS mutedUntil, alert_rule_ids AS alertRuleIds, type, config, status, health, severity, version, evaluated_at AS evaluatedAt, (SELECT id FROM groups WHERE monitor_id = monitors.id ORDER BY status = 'unresolved' DESC, id LIMIT 1) AS issueId, (SELECT json_object('id', g.id, 'shortId', upper(p.slug) || '-' || g.short_id, 'title', g.title, 'status', g.status, 'lastSeen', g.last_seen) FROM groups g JOIN projects p ON p.id = g.project_id WHERE g.monitor_id = monitors.id ORDER BY g.last_seen DESC, g.id DESC LIMIT 1) AS lastIssue, CASE WHEN provisioned = 1 THEN json_object('kind', 'sdk') WHEN created_by IS NULL THEN json_object('kind', 'former_member') ELSE json_object('kind', 'member', 'userId', created_by) END AS creator, notify, created_at AS createdAt";

export class MonitorStore {
  readonly #db: D1Database;
  readonly timeline: MonitorTimeline;

  constructor(db: D1Database) {
    this.#db = db;
    this.timeline = new MonitorTimeline(db);
  }

  async create(
    organizationId: number,
    monitor: NewMonitor,
    actor: CreateIdentity,
  ): Promise<ApiMonitor | null> {
    const { userId, time, requestKey } = actor;

    const row = await this.#db
      .prepare(`INSERT INTO monitors (id, project_id, name, type, config, created_at, notify,
          description, owner_id, alert_rule_ids, changed_by, created_by, request_key)
        SELECT ?1, id, ?4, ?5, ?6, ?7, ?8, ?10, ?11, ?12, ?13, ?13, ?14 FROM projects WHERE id = ?3 AND organization_id = ?2
          AND (SELECT COUNT(*) FROM monitors m JOIN projects p ON p.id = m.project_id
            WHERE p.organization_id = ?2 AND m.status != 'archived') < ?9
        ON CONFLICT DO NOTHING RETURNING ${COLUMNS}`)
      .bind(
        crypto.randomUUID(),
        organizationId,
        monitor.projectId,
        monitor.name,
        monitor.type,
        JSON.stringify(monitor.config),
        time,
        Number(monitor.notify),
        MAX_MONITORS_PER_ORGANIZATION,
        monitor.description,
        monitor.ownerId,
        JSON.stringify(monitor.alertRuleIds),
        userId,
        requestKey,
      )
      .first();

    if (row !== null) {
      return Row.parse(row);
    }

    if (requestKey === null) {
      return null;
    }

    const existing = await this.#db
      .prepare(`SELECT ${COLUMNS} FROM monitors WHERE project_id = ?1 AND request_key = ?2`)
      .bind(monitor.projectId, requestKey)
      .first();

    return existing === null ? null : Row.parse(existing);
  }

  async find(organizationId: number, id: string): Promise<ApiMonitor | null> {
    const row = await this.#db
      .prepare(`SELECT ${COLUMNS} FROM monitors WHERE id = ?1
      AND project_id IN (SELECT id FROM projects WHERE organization_id = ?2)`)
      .bind(id, organizationId)
      .first();

    return row === null ? null : Row.parse(row);
  }

  async edit(
    current: ApiMonitor,
    edit: Control & { monitor: NewMonitor; replan: CronReplan },
  ): Promise<ApiMonitor | null> {
    const { monitor, version, userId, time, replan } = edit;
    const token = crypto.randomUUID();
    const changed = JSON.stringify(monitor.config) !== JSON.stringify(current.config);

    // A metric or uptime config change redefines failure, so it starts a new
    // generation and closes the open incident (invalidationStatements). A
    // cron edit keeps its environments, streaks and incidents, as on Sentry,
    // and only re-plans the next expected check-in under the new schedule.
    const reset = changed && monitor.type !== "cron";

    const update = this.#db
      .prepare(`
      UPDATE OR IGNORE monitors
      SET name = ?3, config = ?4, notify = ?5, version = version + 1, write_token = ?12,
        description = ?7, owner_id = ?8, alert_rule_ids = ?9, changed_by = ?10, changed_at = ?11,
        severity = CASE WHEN ?6 THEN NULL ELSE severity END, health = CASE WHEN ?6 THEN 'awaiting_data' ELSE health END,
        evaluated_at = CASE WHEN ?6 THEN NULL ELSE evaluated_at END,
        generation = generation + ?6,
        evaluation_after = CASE WHEN ?6 THEN ?11 ELSE evaluation_after END,
        successes = CASE WHEN ?6 THEN 0 ELSE successes END,
        failures = CASE WHEN ?6 THEN 0 ELSE failures END,
        lease_token = CASE WHEN ?6 THEN NULL ELSE lease_token END,
        lease_expires = CASE WHEN ?6 THEN NULL ELSE lease_expires END
      WHERE id = ?1 AND version = ?2 AND status != 'archived'
      RETURNING ${COLUMNS}`)
      .bind(
        current.id,
        version,
        monitor.name,
        JSON.stringify(monitor.config),
        Number(monitor.notify),
        Number(reset),
        monitor.description,
        monitor.ownerId,
        JSON.stringify(monitor.alertRuleIds),
        userId,
        time,
        token,
      );

    const statements = [update];

    if (reset) {
      statements.push(...invalidationStatements(this.#db, { id: current.id, token, time }));
    }

    if (replan !== null) {
      // Bumping the revision fences any check-in write that read the old plan.
      // The token makes this apply only if the update above won.
      statements.push(
        this.#db
          .prepare(`UPDATE cron_environments SET next_checkin = ?3, next_checkin_latest = ?4,
            revision = revision + 1, write_token = NULL
          WHERE monitor_id = ?1 AND last_checkin IS NOT NULL
            AND (SELECT write_token FROM monitors WHERE id = ?1) = ?2`)
          .bind(current.id, token, replan.nextCheckIn, replan.nextCheckInLatest),
      );
    }

    const [updated] = await this.#db.batch(statements);
    const row = updated?.results[0];

    return row === undefined ? null : Row.parse(row);
  }

  async setStatus(
    id: string,
    change: Control & { status: ApiMonitor["status"]; replan: CronReplan },
  ): Promise<ApiMonitor | null> {
    const token = crypto.randomUUID();

    const update = this.#db
      .prepare(`
        UPDATE monitors SET status = ?3, version = version + 1, generation = generation + 1,
          write_token = ?6,
          changed_by = ?4, changed_at = ?5, evaluation_after = ?5,
          health = 'awaiting_data', severity = NULL, evaluated_at = NULL,
          successes = 0, failures = 0, lease_token = NULL, lease_expires = NULL
        WHERE id = ?1 AND version = ?2 AND status != 'archived' AND status != ?3 RETURNING ${COLUMNS}`)
      .bind(id, change.version, change.status, change.userId, change.time, token);

    const statements = [update];
    const { replan } = change;

    // Archiving ends the incident; pausing and resuming keep it open.
    if (change.status === "archived") {
      statements.push(...invalidationStatements(this.#db, { id, token, time: change.time }));
    }

    if (replan !== null) {
      // A resumed cron monitor starts a fresh streak and expects its next
      // check-in from now, so a job that stopped while paused is still missed.
      // Outcomes of runs that started before the resume cannot move the new
      // streak (last_decided). History and open incidents stay.
      statements.push(
        this.#db
          .prepare(`UPDATE cron_environments SET status = 'active', health = 'awaiting_data',
            failures = 0, successes = 0, last_decided = ?5,
            next_checkin = CASE WHEN last_checkin IS NULL THEN NULL ELSE ?3 END,
            next_checkin_latest = CASE WHEN last_checkin IS NULL THEN NULL ELSE ?4 END,
            revision = revision + 1, write_token = NULL
          WHERE monitor_id = ?1 AND (SELECT write_token FROM monitors WHERE id = ?1) = ?2`)
          .bind(id, token, replan.nextCheckIn, replan.nextCheckInLatest, change.time),
      );
    }

    const [updated] = await this.#db.batch(statements);

    const row = updated?.results[0];

    return row === undefined ? null : Row.parse(row);
  }

  async mute(id: string, input: Control & { until: number | null }): Promise<ApiMonitor | null> {
    const row = await this.#db
      .prepare(`UPDATE monitors SET muted_until = ?3, version = version + 1,
      changed_by = ?4, changed_at = ?5
      WHERE id = ?1 AND version = ?2 AND status != 'archived' RETURNING ${COLUMNS}`)
      .bind(id, input.version, input.until, input.userId, input.time)
      .first();

    return row === null ? null : Row.parse(row);
  }

  /**
   * Deletes expired monitor data. Runs every minute tick with a bounded batch
   * per table, so it keeps pace with up to 7.2 million rows a day per table
   * without a single long statement.
   */
  async prune(now: number): Promise<void> {
    const db = this.#db;
    const limit = PRUNE_BATCH;

    const prune = (sql: string, before: number): D1PreparedStatement =>
      db.prepare(sql).bind(before, limit);

    await db.batch([
      // Receipts dedupe redeliveries, so they outlive the events queue's retries.
      prune(
        `DELETE FROM metric_receipts WHERE (project_id, event_id) IN
        (SELECT project_id, event_id FROM metric_receipts WHERE minute < ?1 LIMIT ?2)`,
        now - DAY,
      ),
      prune(
        `DELETE FROM metric_level_minutes WHERE (project_id, minute, environment, level) IN
        (SELECT project_id, minute, environment, level FROM metric_level_minutes WHERE minute < ?1 LIMIT ?2)`,
        now - HISTORY,
      ),
      // A pending row the consumer never cleared belongs to a message that was
      // lost. After two hours, longer than the 60-minute window plus its lag,
      // it is treated as never accepted rather than holding windows unknown.
      prune(
        `DELETE FROM metric_pending WHERE (project_id, event_id) IN
        (SELECT project_id, event_id FROM metric_pending WHERE received_at < ?1 LIMIT ?2)`,
        now - 2 * HOUR,
      ),
      prune(
        `DELETE FROM monitor_observations WHERE id IN
        (SELECT id FROM monitor_observations WHERE evaluated_at < ?1 LIMIT ?2)`,
        now - HISTORY,
      ),
      prune(
        `DELETE FROM cron_checkins WHERE id IN
        (SELECT id FROM cron_checkins WHERE date_added < ?1 LIMIT ?2)`,
        now - CHECK_IN_HISTORY,
      ),
      prune(
        `DELETE FROM cron_unrecognized WHERE (project_id, slug, environment, reason) IN
        (SELECT project_id, slug, environment, reason FROM cron_unrecognized WHERE last_seen < ?1 LIMIT ?2)`,
        now - CHECK_IN_HISTORY,
      ),
      // Deliveries cascade with their transitions.
      prune(
        `DELETE FROM monitor_transitions WHERE id IN
        (SELECT id FROM monitor_transitions WHERE happened_at < ?1 LIMIT ?2)`,
        now - INCIDENT_HISTORY,
      ),
      prune(
        `DELETE FROM monitor_periods WHERE id IN
        (SELECT id FROM monitor_periods WHERE closed_at < ?1 LIMIT ?2)`,
        now - INCIDENT_HISTORY,
      ),
      prune(
        `DELETE FROM monitor_audit WHERE (monitor_id, version) IN
        (SELECT monitor_id, version FROM monitor_audit WHERE happened_at < ?1 LIMIT ?2)`,
        now - INCIDENT_HISTORY,
      ),
    ]);
  }

  async metricPreview(
    monitor: Extract<NewMonitor, { type: "metric" }>,
    windowEnd: number,
  ): Promise<{ time: number; count: number; covered: boolean }[]> {
    const { projectId, config } = monitor;

    const { results } = await this.#db
      .prepare(previewMetricQuery)
      .bind(windowEnd, projectId, JSON.stringify(config), config.windowSeconds * 1000)
      .all<{ time: number; count: number; covered: number }>();

    return results.map(({ time, count, covered }) => ({ time, count, covered: covered === 1 }));
  }
  async list(
    organizationId: number,
    project: { kind: "all" } | { kind: "one"; id: number },
  ): Promise<ApiMonitor[]> {
    const { results } = await this.#db
      .prepare(`SELECT * FROM (
        SELECT ${COLUMNS} FROM monitors
        WHERE project_id IN (SELECT id FROM projects WHERE organization_id = ?1)
          AND (?2 IS NULL OR project_id = ?2) AND status != 'archived'
        ORDER BY created_at DESC, id DESC LIMIT 100
      )`)
      .bind(organizationId, project.kind === "all" ? null : project.id)
      .all();

    return results.map((row) => Row.parse(row));
  }
}
