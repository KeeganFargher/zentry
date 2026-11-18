import { jsonText } from "@/shared/json";
import { CronConfig } from "@/shared/monitors";
import type { CronSettings, MonitorCheckIn } from "@/shared/monitors";
import { MINUTE } from "@/shared/time";

const Config = jsonText(CronConfig);

const RECORD_CHECK_IN = `
  INSERT INTO cron_checkins (monitor_id, check_in_id, status, received_at, duration_ms, generation)
  SELECT id, ?3, ?4, ?5, ?6, generation FROM monitors
  WHERE id = ?1 AND version = ?2 AND status = 'active'
    AND NOT EXISTS (
      SELECT 1 FROM cron_checkins c WHERE c.monitor_id = monitors.id
        AND c.check_in_id = ?3 AND c.generation != monitors.generation
    )
  ON CONFLICT DO NOTHING`;

const FIND_SCOPE = `
  SELECT id, version, config, next_cron_at FROM monitors
  WHERE project_id = ?1 AND type = 'cron' AND status = 'active'
    AND json_extract(config, '$.slug') = ?2 AND json_extract(config, '$.environment') = ?3`;

type Scope = { id: string; version: number; config: string; next_cron_at: number | null };

type NextOccurrence = (settings: CronSettings, time: number) => number;

export class CronMonitorStore {
  readonly #db: D1Database;
  readonly #next: NextOccurrence;

  constructor(db: D1Database, next: NextOccurrence) {
    this.#db = db;
    this.#next = next;
  }

  async record(projectId: number, checkIn: MonitorCheckIn, receivedAt: number): Promise<boolean> {
    const { check_in_id, monitor_slug, status, environment, duration } = checkIn;
    const db = this.#db;

    const scope = await db
      .prepare(FIND_SCOPE)
      .bind(projectId, monitor_slug, environment)
      .first<Scope>();

    if (scope === null) {
      return false;
    }

    const config = Config.parse(scope.config);
    const durationMs = duration === undefined ? null : Math.round(duration * 1000);
    const expected = scope.next_cron_at;

    const current =
      expected !== null &&
      receivedAt >= expected - Math.min(30_000, config.graceMinutes * MINUTE) &&
      receivedAt <= expected + config.graceMinutes * MINUTE;

    const next =
      expected === null || current ? this.#next(config, expected ?? receivedAt) : expected;

    // Pairing by run ID protects terminal decisions when a start is redelivered.
    const statements = [
      db
        .prepare(RECORD_CHECK_IN)
        .bind(scope.id, scope.version, check_in_id, status, receivedAt, durationMs),
      db
        .prepare(`UPDATE monitors SET next_cron_at = ?3
        WHERE id = ?1 AND version = ?2 AND changes() = 1 AND next_cron_at IS ?4
          AND (SELECT COUNT(*) FROM cron_checkins WHERE monitor_id = ?1 AND check_in_id = ?5) = 1`)
        .bind(scope.id, scope.version, next, expected, check_in_id),
    ];

    await db.batch(statements);

    return true;
  }

  async evaluate(now: number): Promise<void> {
    const db = this.#db;

    await db
      .prepare(`
      UPDATE cron_checkins SET timed_out = 1 WHERE (monitor_id, check_in_id, status) IN (
        SELECT c.monitor_id, c.check_in_id, c.status FROM cron_checkins c JOIN monitors m ON m.id = c.monitor_id
        WHERE c.status = 'in_progress' AND c.timed_out = 0 AND m.status = 'active' AND c.generation = m.generation
          AND c.received_at + json_extract(m.config, '$.maxRuntimeMinutes') * 60000 <= ?1
          AND NOT EXISTS (
            SELECT 1 FROM cron_checkins terminal WHERE terminal.monitor_id = c.monitor_id
              AND terminal.check_in_id = c.check_in_id AND terminal.status IN ('ok','error')
          )
        ORDER BY c.received_at LIMIT 100
      )`)
      .bind(now)
      .run();

    const { results } = await db
      .prepare(`
      SELECT id, version, config, next_cron_at FROM monitors WHERE type = 'cron' AND status = 'active'
        AND next_cron_at + json_extract(config, '$.graceMinutes') * 60000 <= ?1
      ORDER BY next_cron_at LIMIT 100`)
      .bind(now)
      .all<Scope>();

    if (results.length === 0) {
      return;
    }

    await db.batch(
      results.map((scope) =>
        db
          .prepare(`
      UPDATE monitors SET next_cron_at = ?4, evaluated_at = ?5,
        health = CASE
          WHEN failures + 1 >= json_extract(config, '$.failureThreshold') OR health = 'failing' THEN 'failing'
          ELSE 'degraded' END,
        failures = failures + 1, successes = 0,
        last_result = json_object('outcome','missed','expectedAt',?3)
      WHERE id = ?1 AND version = ?2 AND next_cron_at = ?3 AND status = 'active'
       AND (evaluated_at IS NULL OR evaluated_at <= ?5)`)
          .bind(
            scope.id,
            scope.version,
            scope.next_cron_at,
            this.#afterMiss(Config.parse(scope.config), scope.next_cron_at ?? now, now),
            now,
          ),
      ),
    );
  }

  #afterMiss(config: CronSettings, due: number, now: number): number {
    if ("intervalMinutes" in config) {
      const interval = config.intervalMinutes * MINUTE;

      return due + (Math.floor((now - due) / interval) + 1) * interval;
    }

    return this.#next(config, now);
  }
}
