import { z } from "zod";

import { jsonText } from "@/shared/json";
import { CreateMonitor, MonitorFields } from "@/shared/monitors";
import type { ApiMonitor, NewMonitor } from "@/shared/monitors";
import { DAY } from "@/shared/time";

import { evaluateMetricQuery, previewMetricQuery } from "./metric-query";
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

type Actor = { userId: number; time: number };

type Control = Actor & { version: number };

type CreateIdentity = Actor & { requestKey: string | null };

const MAX_MONITORS_PER_ORGANIZATION = 100;

const COLUMNS =
  "id, project_id AS projectId, name, description, owner_id AS ownerId, muted_until AS mutedUntil, alert_rule_ids AS alertRuleIds, type, config, status, health, severity, version, evaluated_at AS evaluatedAt, (SELECT id FROM groups WHERE monitor_id = monitors.id ORDER BY status = 'unresolved' DESC, id LIMIT 1) AS issueId, notify, created_at AS createdAt";

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
          description, owner_id, alert_rule_ids, changed_by, request_key)
        SELECT ?1, id, ?4, ?5, ?6, ?7, ?8, ?10, ?11, ?12, ?13, ?14 FROM projects WHERE id = ?3 AND organization_id = ?2
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
    edit: Control & { monitor: NewMonitor },
  ): Promise<ApiMonitor | null> {
    const { monitor, version, userId, time } = edit;
    const reset = JSON.stringify(monitor.config) !== JSON.stringify(current.config);

    const row = await this.#db
      .prepare(`
      UPDATE OR IGNORE monitors
      SET name = ?3, config = ?4, notify = ?5, version = version + 1,
        description = ?7, owner_id = ?8, alert_rule_ids = ?9, changed_by = ?10, changed_at = ?11,
        severity = CASE WHEN ?6 THEN NULL ELSE severity END, health = CASE WHEN ?6 THEN 'awaiting_data' ELSE health END,
        evaluated_at = CASE WHEN ?6 THEN NULL ELSE evaluated_at END,
        next_cron_at = CASE WHEN ?6 THEN NULL ELSE next_cron_at END,
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
      )
      .first();

    return row === null ? null : Row.parse(row);
  }

  async setStatus(
    id: string,
    change: Control & { status: ApiMonitor["status"] },
  ): Promise<ApiMonitor | null> {
    const row = await this.#db
      .prepare(`
      UPDATE monitors SET status = ?3, version = version + 1, generation = generation + 1,
        changed_by = ?4, changed_at = ?5, evaluation_after = ?5,
        health = 'awaiting_data', severity = NULL, evaluated_at = NULL, next_cron_at = NULL,
        successes = 0, failures = 0, lease_token = NULL, lease_expires = NULL
      WHERE id = ?1 AND version = ?2 AND status != 'archived' AND status != ?3 RETURNING ${COLUMNS}`)
      .bind(id, change.version, change.status, change.userId, change.time)
      .first();

    return row === null ? null : Row.parse(row);
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

  async prune(now: number): Promise<void> {
    const db = this.#db;

    await db.batch([
      db
        .prepare(`DELETE FROM metric_receipts WHERE (project_id, event_id) IN
        (SELECT project_id, event_id FROM metric_receipts WHERE minute < ?1 LIMIT 16000)`)
        .bind(now - DAY),
      db
        .prepare(`DELETE FROM metric_minutes WHERE (project_id, minute, environment) IN
        (SELECT project_id, minute, environment FROM metric_minutes WHERE minute < ?1 LIMIT 16000)`)
        .bind(now - 14 * DAY),
      db
        .prepare(`DELETE FROM monitor_observations WHERE id IN
        (SELECT id FROM monitor_observations WHERE evaluated_at < ?1 LIMIT 16000)`)
        .bind(now - 14 * DAY),
      db
        .prepare(`DELETE FROM cron_receipts WHERE (monitor_id, environment, run_id, phase) IN
        (SELECT monitor_id, environment, run_id, phase FROM cron_receipts WHERE received_at < ?1 LIMIT 16000)`)
        .bind(now - 14 * DAY),
      db
        .prepare(`DELETE FROM cron_runs WHERE (monitor_id, environment, generation, slot) IN
        (SELECT monitor_id, environment, generation, slot FROM cron_runs WHERE received_at < ?1 LIMIT 16000)`)
        .bind(now - 14 * DAY),
      db
        .prepare(`DELETE FROM metric_level_minutes WHERE (project_id, minute, environment, level) IN
        (SELECT project_id, minute, environment, level FROM metric_level_minutes WHERE minute < ?1 LIMIT 16000)`)
        .bind(now - 14 * DAY),
      db
        .prepare(`DELETE FROM metric_pending WHERE (project_id, event_id) IN
        (SELECT project_id, event_id FROM metric_pending WHERE received_at < ?1 LIMIT 16000)`)
        .bind(now - 14 * DAY),
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
  async evaluateMetrics(windowEnd: number): Promise<void> {
    await this.#db.prepare(evaluateMetricQuery).bind(windowEnd).run();
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
