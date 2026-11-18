import { jsonText } from "@/shared/json";
import { UptimeConfig } from "@/shared/monitors";
import type { UptimeJob, UptimeSettings } from "@/shared/monitors";
import { MINUTE } from "@/shared/time";

type Claim = { slot: number; token: string; now: number };

export type ProbeResult = {
  outcome: "ok" | "failed" | "unknown";
  httpStatus?: number | undefined;
  durationMs?: number | undefined;
};

const Config = jsonText(UptimeConfig);

export class UptimeMonitorStore {
  readonly #db: D1Database;

  constructor(db: D1Database) {
    this.#db = db;
  }

  async claim(claim: Claim): Promise<{ id: string }[]> {
    const { results } = await this.#db
      .prepare(`
      UPDATE monitors SET lease_token = ?2, lease_expires = ?3, slot = ?1, probe_started = 0
      WHERE id IN (
        SELECT id FROM monitors
        WHERE type = 'uptime' AND status = 'active' AND created_at <= ?1
          AND (lease_expires IS NULL OR lease_expires <= ?4)
          AND (evaluated_at IS NULL OR evaluated_at + json_extract(config, '$.intervalMinutes') * 60000 <= ?1)
        ORDER BY evaluated_at, id LIMIT 100
      )
      RETURNING id`)
      .bind(claim.slot, claim.token, claim.now + MINUTE, claim.now)
      .all<{ id: string }>();

    return results;
  }

  async start(job: UptimeJob, now: number): Promise<UptimeSettings | null> {
    const row = await this.#db
      .prepare(`
      UPDATE monitors SET probe_started = 1
      WHERE id = ?1 AND lease_token = ?2 AND lease_expires > ?3 AND status = 'active' AND probe_started = 0
      RETURNING config`)
      .bind(job.id, job.token, now)
      .first<{ config: string }>();

    return row === null ? null : Config.parse(row.config);
  }

  async retry(job: UptimeJob): Promise<void> {
    await this.#db
      .prepare("UPDATE monitors SET probe_started = 0 WHERE id = ?1 AND lease_token = ?2")
      .bind(job.id, job.token)
      .run();
  }

  async finish(job: UptimeJob, result: ProbeResult): Promise<void> {
    await this.#db
      .prepare(`
      UPDATE monitors SET evaluated_at = slot, lease_expires = NULL, lease_token = NULL,
        last_result = ?4,
        failures = CASE ?3 WHEN 'failed' THEN failures + 1 ELSE 0 END,
        successes = CASE ?3 WHEN 'ok' THEN successes + 1 ELSE 0 END,
        health = CASE
          WHEN ?3 = 'unknown' THEN 'unknown'
          WHEN ?3 = 'failed' AND failures + 1 >= json_extract(config, '$.failureThreshold') THEN 'failing'
          WHEN ?3 = 'ok' AND successes + 1 >= json_extract(config, '$.recoveryThreshold') THEN 'healthy'
          WHEN health = 'failing' THEN 'failing'
          ELSE 'degraded'
        END
      WHERE id = ?1 AND lease_token = ?2 AND status = 'active'`)
      .bind(job.id, job.token, result.outcome, JSON.stringify(result))
      .run();
  }
}
