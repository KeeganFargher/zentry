import { jsonText } from "@/shared/json";
import { UptimeConfig } from "@/shared/monitors";
import type { ScheduledUptimeJob, UptimeSettings } from "@/shared/monitors";
import { MINUTE } from "@/shared/time";

type Claim = { slot: number; token: string; now: number };

export type ProbeResult = {
  outcome: "ok" | "failed" | "unknown";
  httpStatus?: number | undefined;
  durationMs?: number | undefined;
  reason?: "policy" | "timeout" | "network" | "status" | "budget" | "paused" | undefined;
};

export type ProbeRequest = { config: UptimeSettings; organizationId: number };

const Config = jsonText(UptimeConfig);

export class UptimeMonitorStore {
  readonly #db: D1Database;

  constructor(db: D1Database) {
    this.#db = db;
  }

  async claim(claim: Claim): Promise<{ id: string }[]> {
    await this.#markGaps(claim);

    const { results } = await this.#db
      .prepare(`
      UPDATE monitors SET lease_token = ?2, lease_expires = ?3, slot = ?1, probe_started = 0
      WHERE id IN (
        SELECT id FROM monitors
        WHERE type = 'uptime' AND status = 'active' AND created_at <= ?1
          AND (lease_expires IS NULL OR lease_expires <= ?4)
          AND (evaluated_at IS NULL OR evaluated_at + json_extract(config,'$.intervalMinutes') * 60000 <= ?1)
        ORDER BY evaluated_at, id LIMIT 100
      )
      RETURNING id`)
      .bind(claim.slot, claim.token, claim.now + MINUTE, claim.now)
      .all<{ id: string }>();

    return results;
  }

  async #markGaps(claim: Claim): Promise<void> {
    await this.#db
      .prepare(`
      UPDATE monitors SET evaluated_at = CASE
          WHEN lease_expires <= ?2 AND slot >= ?1 THEN slot
          ELSE MAX(COALESCE(slot, 0), ?1 - json_extract(config,'$.intervalMinutes') * 60000) END,
        health = 'unknown', successes = 0, failures = 0, probe_started = 0,
        lease_token = NULL, lease_expires = NULL,
        last_result = json_object('outcome','unknown','reason','coverage_gap','skippedSlots',
          MAX(1, (?1 - COALESCE(evaluated_at,slot,?1)) / (json_extract(config,'$.intervalMinutes') * 60000) - 1))
      WHERE type = 'uptime' AND status = 'active'
        AND (lease_expires IS NULL OR lease_expires <= ?2)
        AND ((lease_expires IS NOT NULL AND lease_expires <= ?2)
          OR (evaluated_at IS NOT NULL AND evaluated_at + 2 * json_extract(config,'$.intervalMinutes') * 60000 <= ?1))
        AND (evaluated_at IS NULL OR evaluated_at < ?1)
    `)
      .bind(claim.slot, claim.now)
      .run();
  }

  async start(job: ScheduledUptimeJob, now: number): Promise<ProbeRequest | null> {
    const row = await this.#db
      .prepare(`
      UPDATE monitors SET probe_started = 1
      WHERE id = ?1 AND lease_token = ?2 AND lease_expires > ?3 AND status = 'active' AND probe_started = 0
      RETURNING config, (SELECT organization_id FROM projects WHERE id = monitors.project_id) AS organizationId`)
      .bind(job.id, job.token, now)
      .first<{ config: string; organizationId: number }>();

    return row === null
      ? null
      : { config: Config.parse(row.config), organizationId: row.organizationId };
  }

  async finish(job: ScheduledUptimeJob, result: ProbeResult, now: number): Promise<void> {
    await this.#db
      .prepare(`
      UPDATE monitors SET evaluated_at = slot, lease_expires = NULL, lease_token = NULL,
        last_result = ?4,
        failures = CASE ?3 WHEN 'failed' THEN failures + 1 ELSE 0 END,
        successes = CASE ?3 WHEN 'ok' THEN successes + 1 ELSE 0 END,
        health = CASE
          WHEN ?3 = 'unknown' THEN 'unknown'
          WHEN ?3 = 'failed' AND failures + 1 >= json_extract(config,'$.failureThreshold') THEN 'failing'
          WHEN ?3 = 'ok' AND successes + 1 >= json_extract(config,'$.recoveryThreshold') THEN 'healthy'
          WHEN health = 'failing' OR EXISTS(SELECT 1 FROM groups WHERE monitor_id = monitors.id AND status = 'unresolved') THEN 'failing'
          ELSE 'degraded'
        END
      WHERE id = ?1 AND lease_token = ?2 AND status = 'active' AND lease_expires > ?5`)
      .bind(job.id, job.token, result.outcome, JSON.stringify(result), now)
      .run();
  }
}
