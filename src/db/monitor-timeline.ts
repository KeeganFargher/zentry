import { z } from "zod";

import type {
  MonitorAudit,
  MonitorCoverage,
  MonitorIncidentPeriod,
  MonitorDeliveryState,
  CronReceiptView,
  MonitorObservation,
  MonitorScope,
} from "@/shared/contract";
import { jsonText } from "@/shared/json";

export class MonitorTimeline {
  readonly #db: D1Database;

  constructor(db: D1Database) {
    this.#db = db;
  }

  async history(
    organizationId: number,
    id: string,
    page: { time: number; id: number; size: number },
  ): Promise<MonitorObservation[]> {
    const { results } = await this.#db
      .prepare(`
      SELECT o.id, o.evaluated_at AS time, o.health, o.evidence, o.scope, o.slot, o.severity
      FROM monitor_observations o JOIN monitors m ON m.id = o.monitor_id
      JOIN projects p ON p.id = m.project_id
      WHERE m.id = ?1 AND p.organization_id = ?2 AND (o.evaluated_at, o.id) < (?3, ?4)
      ORDER BY o.evaluated_at DESC, o.id DESC LIMIT ?5`)
      .bind(id, organizationId, page.time, page.id, page.size)
      .all<Omit<MonitorObservation, "evidence"> & { evidence: string }>();

    const evidenceSchema = jsonText(z.json());

    return results.map(({ evidence, ...entry }) =>
      Object.assign(entry, { evidence: evidenceSchema.parse(evidence) }),
    );
  }

  async audit(id: string): Promise<MonitorAudit[]> {
    const { results } = await this.#db
      .prepare(`SELECT version, actor_id AS actorId,
      happened_at AS time, snapshot FROM monitor_audit WHERE monitor_id = ?1 ORDER BY version DESC LIMIT 50`)
      .bind(id)
      .all<Omit<MonitorAudit, "snapshot"> & { snapshot: string }>();

    const snapshotSchema = jsonText(z.json());

    return results.map(({ snapshot, ...entry }) =>
      Object.assign(entry, { snapshot: snapshotSchema.parse(snapshot) }),
    );
  }

  async scopes(id: string): Promise<MonitorScope[]> {
    const { results } = await this.#db
      .prepare(`SELECT s.environment, s.health, s.next_at AS nextAt,
      g.id AS issueId FROM cron_scopes s LEFT JOIN groups g
      ON g.monitor_id = s.monitor_id AND g.monitor_scope = s.environment
      WHERE s.monitor_id = ?1 ORDER BY s.environment`)
      .bind(id)
      .all<MonitorScope>();

    return results;
  }

  async uptimeCoverage(id: string, since: number): Promise<MonitorCoverage | null> {
    return this.#db
      .prepare(`SELECT
      COALESCE(SUM(json_extract(evidence,'$.outcome') = 'ok'),0) AS successful,
      COALESCE(SUM(json_extract(evidence,'$.outcome') = 'failed'),0) AS failed,
      COALESCE(SUM(CASE WHEN json_extract(evidence,'$.outcome') = 'unknown'
        THEN COALESCE(json_extract(evidence,'$.skippedSlots'),1) ELSE 0 END),0) AS unknown
      FROM monitor_observations WHERE monitor_id = ?1 AND evaluated_at >= ?2`)
      .bind(id, since)
      .first<MonitorCoverage>();
  }

  async deliveries(id: string): Promise<MonitorDeliveryState[]> {
    const { results } = await this.#db
      .prepare(`SELECT d.id, d.channel, d.transition_type AS transition,
      d.happened_at AS time, d.suppression FROM monitor_deliveries d JOIN monitor_transitions t
      ON t.id = d.transition_id WHERE t.monitor_id = ?1 ORDER BY d.id DESC LIMIT 25`)
      .bind(id)
      .all<MonitorDeliveryState>();

    return results;
  }

  async checkIns(id: string): Promise<CronReceiptView[]> {
    const { results } = await this.#db
      .prepare(`SELECT r.environment, r.run_id AS runId, r.status,
      r.received_at AS receivedAt, run.slot, r.duration_ms AS durationMs
      FROM cron_receipts r LEFT JOIN cron_runs run ON run.monitor_id = r.monitor_id
        AND run.environment = r.environment AND run.run_id = r.run_id
      WHERE r.monitor_id = ?1 ORDER BY r.received_at DESC LIMIT 25`)
      .bind(id)
      .all<CronReceiptView>();

    return results;
  }

  async incidents(id: string): Promise<MonitorIncidentPeriod[]> {
    const { results } = await this.#db
      .prepare(`SELECT g.id AS issueId, g.monitor_scope AS scope,
      p.opened_at AS openedAt, p.closed_at AS closedAt, p.disposition
      FROM groups g JOIN monitor_periods p ON p.group_id = g.id WHERE g.monitor_id = ?1
      ORDER BY p.opened_at DESC, p.id DESC LIMIT 50`)
      .bind(id)
      .all<MonitorIncidentPeriod>();

    return results;
  }
}
