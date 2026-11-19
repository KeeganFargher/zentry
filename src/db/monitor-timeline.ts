import { z } from "zod";

import type {
  MonitorAudit,
  MonitorCoverage,
  MonitorIncidentPeriod,
  MonitorDeliveryState,
  CronCheckInView,
  CronUnrecognized,
  MonitorObservation,
  MonitorScope,
} from "@/shared/contract";
import { jsonText } from "@/shared/json";
import type { MonitorTimeline as TimelineView, TimelineBucket } from "@/shared/monitor-views";
import type { ApiMonitor } from "@/shared/monitors";

// One row per bucket, scope and status. ?1 monitor, ?2 since, ?3 until, ?4 bucket width.
const BUCKET_SQL: Record<ApiMonitor["type"], string> = {
  cron: `SELECT CAST((date_added - ?2) / ?4 AS INTEGER) AS "index", environment AS scope,
      status, COUNT(*) AS count, NULL AS value
    FROM cron_checkins WHERE monitor_id = ?1 AND date_added >= ?2 AND date_added < ?3
    GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
  // A failure while the scope is failing is downtime, as Sentry's
  // failure_incident; a failure before the threshold is just a failure.
  uptime: `SELECT CAST((evaluated_at - ?2) / ?4 AS INTEGER) AS "index", scope,
      CASE json_extract(evidence, '$.outcome')
        WHEN 'ok' THEN 'success'
        WHEN 'failed' THEN CASE health WHEN 'failing' THEN 'downtime' ELSE 'failure' END
        ELSE 'unknown' END AS status,
      COUNT(*) AS count, NULL AS value
    FROM monitor_observations WHERE monitor_id = ?1 AND evaluated_at >= ?2 AND evaluated_at < ?3
    GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
  metric: `SELECT CAST((evaluated_at - ?2) / ?4 AS INTEGER) AS "index", scope,
      CASE WHEN health IN ('unknown', 'awaiting_data') THEN 'unknown'
        ELSE COALESCE(severity, 'ok') END AS status,
      COUNT(*) AS count, MAX(json_extract(evidence, '$.count')) AS value
    FROM monitor_observations WHERE monitor_id = ?1 AND evaluated_at >= ?2 AND evaluated_at < ?3
    GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
};

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
      .prepare(`SELECT e.environment, e.health, e.next_checkin AS nextAt,
        e.last_checkin AS lastCheckIn, g.id AS issueId
      FROM cron_environments e LEFT JOIN groups g
        ON g.monitor_id = e.monitor_id AND g.monitor_scope = e.environment
      WHERE e.monitor_id = ?1 ORDER BY e.environment`)
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

  async checkIns(id: string): Promise<CronCheckInView[]> {
    const { results } = await this.#db
      .prepare(`SELECT check_in_id AS checkInId, environment, status,
        CASE status WHEN 'missed' THEN NULL ELSE date_added END AS startedAt,
        completed_at AS completedAt, duration_ms AS durationMs, expected_at AS expectedAt
      FROM cron_checkins WHERE monitor_id = ?1 ORDER BY date_added DESC, id DESC LIMIT 50`)
      .bind(id)
      .all<CronCheckInView>();

    return results;
  }

  async unrecognized(organizationId: number): Promise<CronUnrecognized[]> {
    const { results } = await this.#db
      .prepare(`SELECT u.project_id AS projectId, u.slug, u.environment, u.reason, u.count,
        u.last_seen AS lastSeen
      FROM cron_unrecognized u JOIN projects p ON p.id = u.project_id
      WHERE p.organization_id = ?1 ORDER BY u.last_seen DESC LIMIT 50`)
      .bind(organizationId)
      .all<CronUnrecognized>();

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

  /** Ticks for the monitor's timeline over [since, until), in `bucketMs` steps. */
  async timeline(
    monitor: Pick<ApiMonitor, "id" | "type">,
    range: Omit<TimelineView, "buckets">,
  ): Promise<TimelineView> {
    const { results } = await this.#db
      .prepare(BUCKET_SQL[monitor.type])
      .bind(monitor.id, range.since, range.until, range.bucketMs)
      .all<TimelineBucket>();

    return { ...range, buckets: results };
  }
}
