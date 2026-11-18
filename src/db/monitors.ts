import { z } from "zod";

import type { MonitorObservation } from "@/shared/contract";
import { jsonText } from "@/shared/json";
import { CreateMonitor, MonitorFields } from "@/shared/monitors";
import type { ApiMonitor, NewMonitor } from "@/shared/monitors";
import { DAY } from "@/shared/time";

const Row = MonitorFields.extend({
  projectId: z.int().positive(),
  name: z.string(),
  notify: z.union([z.literal(0), z.literal(1)]).transform(Boolean),
  type: z.string(),
  config: jsonText(z.json()),
}).transform(({ projectId, name, type, config, notify, ...metadata }): ApiMonitor => ({
  ...CreateMonitor.parse({ projectId, name, type, config, notify }),
  ...metadata,
}));

const MAX_MONITORS_PER_ORGANIZATION = 100;

const COLUMNS =
  "id, project_id AS projectId, name, type, config, status, health, version, evaluated_at AS evaluatedAt, (SELECT id FROM groups WHERE monitor_id = monitors.id) AS issueId, notify, created_at AS createdAt";

export class MonitorStore {
  readonly #db: D1Database;

  constructor(db: D1Database) {
    this.#db = db;
  }

  async create(
    organizationId: number,
    monitor: NewMonitor,
    now: number,
  ): Promise<ApiMonitor | null> {
    const row = await this.#db
      .prepare(`INSERT INTO monitors (id, project_id, name, type, config, created_at, notify)
        SELECT ?1, id, ?4, ?5, ?6, ?7, ?8 FROM projects WHERE id = ?3 AND organization_id = ?2
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
        now,
        Number(monitor.notify),
        MAX_MONITORS_PER_ORGANIZATION,
      )
      .first();

    return row === null ? null : Row.parse(row);
  }

  async find(organizationId: number, id: string): Promise<ApiMonitor | null> {
    const row = await this.#db
      .prepare(`SELECT ${COLUMNS} FROM monitors WHERE id = ?1
      AND project_id IN (SELECT id FROM projects WHERE organization_id = ?2)`)
      .bind(id, organizationId)
      .first();

    return row === null ? null : Row.parse(row);
  }

  async history(organizationId: number, id: string): Promise<MonitorObservation[]> {
    const { results } = await this.#db
      .prepare(`
      SELECT o.id, o.evaluated_at AS time, o.health, o.evidence
      FROM monitor_observations o JOIN monitors m ON m.id = o.monitor_id
      JOIN projects p ON p.id = m.project_id
      WHERE m.id = ?1 AND p.organization_id = ?2 ORDER BY o.evaluated_at DESC, o.id DESC LIMIT 50`)
      .bind(id, organizationId)
      .all<Omit<MonitorObservation, "evidence"> & { evidence: string }>();

    const evidenceSchema = jsonText(z.json());

    return results.map(({ id: observationId, time, health, evidence }) => ({
      id: observationId,
      time,
      health,
      evidence: evidenceSchema.parse(evidence),
    }));
  }

  async edit(
    current: ApiMonitor,
    edit: { monitor: NewMonitor; version: number },
  ): Promise<ApiMonitor | null> {
    const { monitor, version } = edit;
    const reset = JSON.stringify(monitor.config) !== JSON.stringify(current.config);

    const row = await this.#db
      .prepare(`
      UPDATE OR IGNORE monitors
      SET name = ?3, config = ?4, notify = ?5, version = version + 1,
        health = CASE WHEN ?6 THEN 'awaiting_data' ELSE health END,
        evaluated_at = CASE WHEN ?6 THEN NULL ELSE evaluated_at END,
        next_cron_at = CASE WHEN ?6 THEN NULL ELSE next_cron_at END,
        generation = generation + ?6,
        successes = CASE WHEN ?6 THEN 0 ELSE successes END,
        failures = CASE WHEN ?6 THEN 0 ELSE failures END,
        lease_token = NULL, lease_expires = NULL
      WHERE id = ?1 AND version = ?2 AND status != 'archived'
      RETURNING ${COLUMNS}`)
      .bind(
        current.id,
        version,
        monitor.name,
        JSON.stringify(monitor.config),
        Number(monitor.notify),
        MAX_MONITORS_PER_ORGANIZATION,
        Number(reset),
      )
      .first();

    return row === null ? null : Row.parse(row);
  }

  async setStatus(
    id: string,
    change: { version: number; status: ApiMonitor["status"] },
  ): Promise<ApiMonitor | null> {
    const row = await this.#db
      .prepare(`
      UPDATE monitors SET status = ?3, version = version + 1, generation = generation + 1,
        health = 'awaiting_data', evaluated_at = NULL, next_cron_at = NULL,
        successes = 0, failures = 0, lease_token = NULL, lease_expires = NULL
      WHERE id = ?1 AND version = ?2 AND status != 'archived' AND status != ?3 RETURNING ${COLUMNS}`)
      .bind(id, change.version, change.status)
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
        .prepare(`DELETE FROM cron_checkins WHERE (monitor_id, check_in_id, status) IN
        (SELECT monitor_id, check_in_id, status FROM cron_checkins WHERE received_at < ?1 LIMIT 16000)`)
        .bind(now - 14 * DAY),
    ]);
  }

  async count(
    monitor: Extract<NewMonitor, { type: "metric" }>,
    windowEnd: number,
  ): Promise<number> {
    const { projectId, config } = monitor;

    const value = await this.#db
      .prepare(`
      SELECT COALESCE(SUM(count), 0) AS count FROM metric_minutes
      WHERE project_id = ?1 AND minute >= ?2 AND minute < ?3 AND (?4 IS NULL OR environment = ?4)`)
      .bind(
        projectId,
        windowEnd - config.windowSeconds * 1000,
        windowEnd,
        config.environment ?? null,
      )
      .first<number>("count");

    return value ?? 0;
  }

  async evaluateMetrics(windowEnd: number): Promise<void> {
    await this.#db
      .prepare(`WITH due AS MATERIALIZED (
          SELECT id, project_id, config, created_at FROM monitors
          WHERE type = 'metric' AND status = 'active'
            AND created_at < ?1 AND (evaluated_at IS NULL OR evaluated_at < ?1)
          ORDER BY evaluated_at, id LIMIT 100
        ), counts AS MATERIALIZED (
          SELECT due.id, COALESCE(SUM(metric_minutes.count), 0) AS count
          FROM due LEFT JOIN metric_minutes
            ON metric_minutes.project_id = due.project_id AND minute < ?1
            AND minute >= ?1 - json_extract(due.config, '$.windowSeconds') * 1000
            AND (json_extract(due.config, '$.environment') IS NULL
              OR environment = json_extract(due.config, '$.environment'))
          GROUP BY due.id
        )
        UPDATE monitors SET evaluated_at = ?1,
          last_result = json_object('count', counts.count, 'windowEnd', ?1),
          health = CASE
            WHEN counts.count >= json_extract(config, '$.threshold') THEN 'failing'
            WHEN created_at > ?1 - json_extract(config, '$.windowSeconds') * 1000 THEN 'awaiting_data'
            WHEN counts.count <= COALESCE(json_extract(config, '$.recoveryThreshold'),
              json_extract(config, '$.threshold') - 1) THEN 'healthy'
            ELSE health
          END
        FROM counts WHERE monitors.id = counts.id`)
      .bind(windowEnd)
      .run();
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
