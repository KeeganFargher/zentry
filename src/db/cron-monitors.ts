import { jsonText } from "@/shared/json";
import { CronConfig } from "@/shared/monitors";
import type { CronSettings, MonitorCheckIn } from "@/shared/monitors";
import { MINUTE } from "@/shared/time";

const Config = jsonText(CronConfig);

const FIND_SCOPE = `
  SELECT m.id, m.config, m.version, s.environment, s.generation, s.revision, s.next_at AS nextAt
  FROM monitors m JOIN cron_scopes s ON s.monitor_id = m.id
  WHERE m.project_id = ?1 AND m.type = 'cron' AND m.status = 'active'
    AND json_extract(m.config, '$.slug') = ?2 AND s.environment = ?3`;

const APPLY_NEXT = `
  INSERT INTO cron_applied (monitor_id, environment, generation, slot, decided_at)
  SELECT s.monitor_id, s.environment, s.generation, run.slot, MAX(?1, run.completed_at,
    COALESCE((SELECT decided_at + 1 FROM cron_applied previous
      WHERE previous.monitor_id = s.monitor_id AND previous.environment = s.environment
        AND previous.generation = s.generation AND previous.slot = s.applied_at), 0))
  FROM cron_scopes s JOIN monitors m ON m.id = s.monitor_id
  JOIN cron_runs run ON run.monitor_id = s.monitor_id AND run.environment = s.environment
    AND run.generation = s.generation AND run.slot = (
      SELECT MIN(pending.slot) FROM cron_runs pending
      WHERE pending.monitor_id = s.monitor_id AND pending.environment = s.environment
        AND pending.generation = s.generation AND pending.slot > COALESCE(s.applied_at, -1)
    )
  WHERE m.status = 'active' AND run.outcome IS NOT NULL AND (?2 IS NULL OR m.id = ?2)
  ORDER BY run.slot, s.monitor_id, s.environment LIMIT 100`;

type Scope = {
  id: string;
  config: string;
  environment: string;
  generation: number;
  revision: number;
  version: number;
  nextAt: number | null;
};

type Input = { checkIn: MonitorCheckIn; time: number };

type NextOccurrence = (settings: CronSettings, time: number) => number;

export class CronMonitorStore {
  readonly #db: D1Database;
  readonly #next: NextOccurrence;

  constructor(db: D1Database, next: NextOccurrence) {
    this.#db = db;
    this.#next = next;
  }

  async record(projectId: number, checkIn: MonitorCheckIn, receivedAt: number): Promise<boolean> {
    const { monitor_slug, environment } = checkIn;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const scope = await this.#db
        .prepare(FIND_SCOPE)
        .bind(projectId, monitor_slug, environment)
        .first<Scope>();

      if (scope === null) {
        return false;
      }

      if (await this.#accept(scope, { checkIn, time: receivedAt })) {
        await this.#apply({ now: receivedAt, monitorId: scope.id });

        return true;
      }
    }

    throw new Error("cron configuration changed during receipt");
  }

  async #accept(scope: Scope, input: Input): Promise<boolean> {
    const db = this.#db;
    const { checkIn, time } = input;
    const { id, version, revision, environment, generation, nextAt } = scope;
    const key = checkIn.check_in_id;
    const status = checkIn.status;
    const writeToken = crypto.randomUUID();
    const phase = status === "in_progress" ? "start" : "finish";
    const config = Config.parse(scope.config);
    const maxRuntime = config.maxRuntimeMinutes * MINUTE;
    const duration = checkIn.duration === undefined ? null : Math.round(checkIn.duration * 1000);

    const eligible =
      nextAt === null || (time >= nextAt - 30_000 && time <= nextAt + config.graceMinutes * MINUTE);

    const slot = nextAt ?? time;
    const next = eligible ? this.#next(config, slot) : nextAt;

    // The successful compare-and-swap owns the receipt. Keeping the receipt
    // and its run in one batch prevents a 2xx for a discarded racing write.
    const results = await db.batch([
      db
        .prepare(`UPDATE cron_scopes SET revision = revision + 1, write_token = ?6
        WHERE monitor_id = ?1 AND environment = ?2 AND revision = ?3
          AND generation = ?4 AND EXISTS (
            SELECT 1 FROM monitors WHERE id = ?1 AND version = ?5 AND status = 'active')`)
        .bind(id, environment, revision, generation, version, writeToken),
      db
        .prepare(`INSERT OR IGNORE INTO cron_receipts
        (monitor_id, environment, run_id, phase, received_at, status, duration_ms)
        SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE changes() = 1`)
        .bind(id, environment, key, phase, time, status, duration),
      db
        .prepare(`UPDATE cron_runs SET completed_at = ?4, duration_ms = ?5,
          outcome = CASE WHEN ?4 > deadline OR ?5 > ?8 THEN 'timed_out' ELSE ?6 END
        WHERE changes() = 1 AND ?7 = 'finish' AND monitor_id = ?1 AND environment = ?2
          AND run_id = ?3 AND generation = ?9 AND outcome IS NULL`)
        .bind(id, environment, key, time, duration, status, phase, maxRuntime, generation),
      db
        .prepare(`INSERT OR IGNORE INTO cron_runs(monitor_id, environment, generation, slot,
          run_id, started_at, received_at, deadline, completed_at, outcome, duration_ms)
        SELECT ?1, ?2, ?3, ?4, ?5, CASE WHEN ?7 = 'start' THEN ?6 END, ?6,
          CASE WHEN ?7 = 'start' THEN ?6 + ?8 END,
          CASE WHEN ?7 = 'finish' THEN ?6 END,
          CASE WHEN ?7 = 'finish' THEN CASE WHEN ?10 > ?8 THEN 'timed_out' ELSE ?9 END END,
          ?10
        WHERE ?11 = 1
          AND (SELECT received_at FROM cron_receipts
               WHERE monitor_id = ?1 AND environment = ?2 AND run_id = ?5 AND phase = ?7) = ?6
          AND EXISTS(SELECT 1 FROM monitors WHERE id = ?1 AND version = ?12 AND status = 'active')
          AND (SELECT write_token FROM cron_scopes WHERE monitor_id = ?1 AND environment = ?2) = ?13
          AND (SELECT COUNT(*) FROM cron_receipts WHERE monitor_id = ?1 AND environment = ?2 AND run_id = ?5) = 1`)
        .bind(
          id,
          environment,
          generation,
          slot,
          key,
          time,
          phase,
          maxRuntime,
          status,
          duration,
          Number(eligible),
          version,
          writeToken,
        ),
      db
        .prepare(`UPDATE cron_scopes SET next_at = ?3
        WHERE changes() = 1 AND monitor_id = ?1 AND environment = ?2`)
        .bind(id, environment, next),
      // A finish received first remains authoritative, but a later start can
      // supply context without running the state machine a second time.
      db
        .prepare(`UPDATE cron_runs SET started_at = ?4
        WHERE monitor_id = ?1 AND environment = ?2 AND run_id = ?3 AND generation = ?5
          AND started_at IS NULL AND outcome IS NOT NULL AND ?6 = 'start'
          AND (SELECT write_token FROM cron_scopes WHERE monitor_id = ?1 AND environment = ?2) = ?7`)
        .bind(id, environment, key, time, generation, phase, writeToken),
    ]);

    return results[0]?.meta.changes === 1;
  }

  async evaluate(now: number): Promise<void> {
    const db = this.#db;

    await db
      .prepare(`UPDATE cron_runs SET outcome = 'timed_out', completed_at = deadline
      WHERE (monitor_id, environment, generation, slot) IN (
        SELECT r.monitor_id, r.environment, r.generation, r.slot
        FROM cron_runs r JOIN monitors m ON m.id = r.monitor_id AND m.generation = r.generation
        WHERE r.outcome IS NULL AND r.deadline <= ?1 AND m.status = 'active'
        ORDER BY r.deadline LIMIT 100)`)
      .bind(now)
      .run();

    const { results } = await db
      .prepare(`
      SELECT m.id, m.config, m.version, s.environment, s.generation, s.revision, s.next_at AS nextAt
      FROM cron_scopes s JOIN monitors m ON m.id = s.monitor_id
      WHERE m.status = 'active' AND s.next_at + json_extract(m.config, '$.graceMinutes') * 60000 < ?1
      ORDER BY s.next_at, s.monitor_id, s.environment LIMIT 100`)
      .bind(now)
      .all<Scope>();

    for (const scope of results) {
      await this.#miss(scope, now);
    }

    await this.#apply({ now });
  }

  async #miss(scope: Scope, now: number): Promise<void> {
    const { id, environment, revision, generation, nextAt } = scope;

    if (nextAt === null) {
      throw new Error("due cron scope has no slot");
    }

    const config = Config.parse(scope.config);
    const following = this.#next(config, nextAt);
    const gap = following + config.graceMinutes * MINUTE < now;

    const afterGap =
      "intervalMinutes" in config
        ? nextAt +
          (Math.floor((now - nextAt) / (config.intervalMinutes * MINUTE)) + 1) *
            config.intervalMinutes *
            MINUTE
        : this.#next(config, now);

    const db = this.#db;

    await db.batch([
      db
        .prepare(`UPDATE cron_scopes SET revision = revision + 1, next_at = ?5
        WHERE monitor_id = ?1 AND environment = ?2 AND revision = ?3 AND generation = ?4`)
        .bind(id, environment, revision, generation, gap ? afterGap : following),
      db
        .prepare(`INSERT INTO cron_runs(monitor_id, environment, generation, slot, received_at, completed_at, outcome)
        SELECT ?1, ?2, ?3, ?4, ?5, ?5, ?6 WHERE changes() = 1`)
        .bind(id, environment, generation, nextAt, now, gap ? "unknown" : "missed"),
    ]);
  }

  async #apply(input: { now: number; monitorId?: string }): Promise<void> {
    const db = this.#db;

    // A recovery can unblock several outcomes after an overlapping run.
    const writes = Array.from({ length: 12 }, () =>
      db.prepare(APPLY_NEXT).bind(input.now, input.monitorId ?? null),
    );

    await db.batch(writes);
  }
}
