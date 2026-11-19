import { z } from "zod";

import { NEW_ENVIRONMENT } from "@/shared/cron";
import type { EnvironmentState, StoredCheckIn } from "@/shared/cron";
import { jsonText } from "@/shared/json";
import { CronConfig, MAX_MONITORS_PER_ORGANIZATION } from "@/shared/monitors";
import type { CronSettings } from "@/shared/monitors";

import { writeEnvironment } from "./cron-write";
import type { EnvironmentRead, Plan, Target } from "./cron-write";

const Config = jsonText(CronConfig);

// A compare-and-swap loses only to a concurrent write to the same
// environment. A few retries cover a burst; more means something is wrong.
const ATTEMPTS = 5;

// Monitors an SDK's monitor_config may create in one project. A public DSN
// could otherwise fill the organization's monitor limit with junk slugs.
const MAX_PROVISIONED_PER_PROJECT = 20;

export type CronMonitor = { id: string; config: CronSettings; status: "active" | "paused" };

export type UnrecognizedReason =
  | "unknown_slug"
  | "invalid_config"
  | "monitor_limit"
  | "environment_limit"
  | "inactive";

export type Unrecognized = {
  projectId: number;
  slug: string;
  environment: string;
  reason: UnrecognizedReason;
};

const MonitorRow = z.object({
  id: z.string(),
  config: Config,
  status: z.enum(["active", "paused"]),
});

const EnvironmentRow = z.object({
  status: z.enum(["active", "ok", "error"]),
  lastCheckIn: z.int().nullable(),
  nextCheckIn: z.int().nullable(),
  nextCheckInLatest: z.int().nullable(),
  lastDecided: z.int().nullable(),
  failures: z.int(),
  successes: z.int(),
  revision: z.int(),
});

const CheckInRecord = z.object({
  id: z.int(),
  environment: z.string(),
  checkInId: z.string(),
  status: z.enum(["in_progress", "ok", "error", "missed", "timeout"]),
  dateAdded: z.int(),
  expectedAt: z.int().nullable(),
  timeoutAt: z.int().nullable(),
  completedAt: z.int().nullable(),
  durationMs: z.int().nullable(),
});

const CHECK_IN_COLUMNS = `id, environment, check_in_id AS checkInId, status, date_added AS dateAdded,
  expected_at AS expectedAt, timeout_at AS timeoutAt, completed_at AS completedAt,
  duration_ms AS durationMs`;

/** D1 access for cron monitors. The rules that decide what to write are in src/core/cron-checkins.ts. */
export class CronStore {
  readonly #db: D1Database;

  constructor(db: D1Database) {
    this.#db = db;
  }

  /** The cron monitor with this slug. The query repeats the partial index's predicate so it is used. */
  async find(projectId: number, slug: string): Promise<CronMonitor | null> {
    const row = await this.#db
      .prepare(`SELECT id, config, status FROM monitors
        WHERE project_id = ?1 AND json_extract(config, '$.slug') = ?2
          AND type = 'cron' AND status != 'archived'`)
      .bind(projectId, slug)
      .first();

    return row === null ? null : MonitorRow.parse(row);
  }

  /**
   * Creates the monitor an SDK's monitor_config describes, unless the project
   * or organization is at its limit. A concurrent first check-in may win the
   * unique slug; either way the caller looks the monitor up again.
   */
  async provision(projectId: number, config: CronSettings, now: number): Promise<void> {
    await this.#db
      .prepare(`INSERT INTO monitors (id, project_id, name, type, config, created_at, provisioned)
        SELECT ?1, p.id, ?3, 'cron', ?4, ?5, 1 FROM projects p WHERE p.id = ?2
          AND (SELECT COUNT(*) FROM monitors m JOIN projects mp ON mp.id = m.project_id
            WHERE mp.organization_id = p.organization_id AND m.status != 'archived') < ?6
          AND (SELECT COUNT(*) FROM monitors m
            WHERE m.project_id = p.id AND m.provisioned = 1 AND m.status != 'archived') < ?7
        ON CONFLICT DO NOTHING`)
      .bind(
        crypto.randomUUID(),
        projectId,
        config.slug,
        JSON.stringify(config),
        now,
        MAX_MONITORS_PER_ORGANIZATION,
        MAX_PROVISIONED_PER_PROJECT,
      )
      .run();
  }

  async environment(monitorId: string, environment: string): Promise<EnvironmentRead> {
    const row = await this.#db
      .prepare(`SELECT status, last_checkin AS lastCheckIn, next_checkin AS nextCheckIn,
          next_checkin_latest AS nextCheckInLatest, last_decided AS lastDecided,
          failures, successes, revision
        FROM cron_environments WHERE monitor_id = ?1 AND environment = ?2`)
      .bind(monitorId, environment)
      .first();

    if (row === null) {
      return { exists: false, revision: 0, state: NEW_ENVIRONMENT };
    }

    const { revision, ...state } = EnvironmentRow.parse(row);

    return { exists: true, revision, state: state satisfies EnvironmentState };
  }

  async environmentCount(monitorId: string): Promise<number> {
    const row = await this.#db
      .prepare(`SELECT COUNT(*) AS count FROM cron_environments WHERE monitor_id = ?1`)
      .bind(monitorId)
      .first<{ count: number }>();

    if (row === null) {
      throw new Error("COUNT returned no row");
    }

    return row.count;
  }

  async checkIn(monitorId: string, checkInId: string): Promise<StoredCheckIn | null> {
    const row = await this.#db
      .prepare(
        `SELECT ${CHECK_IN_COLUMNS} FROM cron_checkins WHERE monitor_id = ?1 AND check_in_id = ?2`,
      )
      .bind(monitorId, checkInId)
      .first();

    return row === null ? null : CheckInRecord.parse(row);
  }

  /** The newest open run, which the all-zero check-in ID refers to. */
  async latestOpen(monitorId: string, environment: string): Promise<StoredCheckIn | null> {
    const row = await this.#db
      .prepare(`SELECT ${CHECK_IN_COLUMNS} FROM cron_checkins
        WHERE monitor_id = ?1 AND environment = ?2 AND status = 'in_progress'
        ORDER BY date_added DESC LIMIT 1`)
      .bind(monitorId, environment)
      .first();

    return row === null ? null : CheckInRecord.parse(row);
  }

  async checkInById(id: number): Promise<StoredCheckIn> {
    const row = await this.#db
      .prepare(`SELECT ${CHECK_IN_COLUMNS} FROM cron_checkins WHERE id = ?1`)
      .bind(id)
      .first();

    return CheckInRecord.parse(row);
  }

  async unrecognized(entry: Unrecognized, now: number): Promise<void> {
    await this.#db
      .prepare(`INSERT INTO cron_unrecognized (project_id, slug, environment, reason, count, last_seen)
        VALUES (?1, ?2, ?3, ?4, 1, ?5)
        ON CONFLICT DO UPDATE SET count = count + 1, last_seen = MAX(last_seen, excluded.last_seen)`)
      .bind(entry.projectId, entry.slug, entry.environment, entry.reason, now)
      .run();
  }

  /**
   * Plans against a fresh read of the environment until its write wins, so a
   * concurrent check-in or tick is always planned against. A null plan means
   * there is nothing to write.
   */
  async update(target: Target, plan: Plan): Promise<void> {
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const read = await this.environment(target.monitorId, target.environment);
      const planned = await plan(read);

      if (planned === null || (await writeEnvironment(this.#db, { ...target, read }, planned))) {
        return;
      }
    }

    throw new Error(
      `cron environment ${target.monitorId}/${target.environment} lost ${ATTEMPTS} concurrent writes`,
    );
  }

  /** Open runs past their runtime deadline, oldest first. */
  async dueTimeouts(now: number, limit: number): Promise<{ id: number; monitor: CronMonitor }[]> {
    const { results } = await this.#db
      .prepare(`SELECT c.id, m.id AS monitorId, m.config, m.status
        FROM cron_checkins c JOIN monitors m ON m.id = c.monitor_id
        WHERE c.status = 'in_progress' AND c.timeout_at <= ?1 AND m.status = 'active'
        ORDER BY c.timeout_at LIMIT ?2`)
      .bind(now, limit)
      .all();

    return results.map((row) => {
      const { id, monitorId, ...monitor } = MonitorRow.omit({ id: true })
        .extend({ id: z.int(), monitorId: z.string() })
        .parse(row);

      return { id, monitor: { id: monitorId, ...monitor } };
    });
  }

  /** Environments whose next check-in is past its margin, most overdue first. */
  async dueEnvironments(
    now: number,
    limit: number,
  ): Promise<{ environment: string; monitor: CronMonitor }[]> {
    const { results } = await this.#db
      .prepare(`SELECT e.environment, m.id, m.config, m.status
        FROM cron_environments e JOIN monitors m ON m.id = e.monitor_id
        WHERE e.next_checkin_latest <= ?1 AND m.status = 'active'
        ORDER BY e.next_checkin_latest LIMIT ?2`)
      .bind(now, limit)
      .all();

    return results.map((row) => {
      const { environment, ...monitor } = MonitorRow.extend({ environment: z.string() }).parse(row);

      return { environment, monitor };
    });
  }
}
