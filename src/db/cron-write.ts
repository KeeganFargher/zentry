import type { CronWrite, EnvironmentState } from "@/shared/cron";

/** An environment as read, with the revision a write must still match. */
export type EnvironmentRead = { exists: boolean; revision: number; state: EnvironmentState };

export type Target = { monitorId: string; environment: string; now: number };

/** Decides what to write from a fresh read; null when there is nothing to write. */
export type Plan = (read: EnvironmentRead) => Promise<CronWrite | null>;

/**
 * One environment's new state, its check-in rows, history for each decided
 * outcome, and the monitor's overall health, in one batch. The first
 * statement claims the revision that was read and stamps a fresh token;
 * every other statement checks that token, so a lost race changes nothing.
 * Returns whether the claim won.
 */
export async function writeEnvironment(
  db: D1Database,
  target: Target & { read: EnvironmentRead },
  write: CronWrite,
): Promise<boolean> {
  const token = crypto.randomUUID();
  const scope = { db, monitorId: target.monitorId, environment: target.environment, token };

  const [claimed] = await db.batch([
    claim(scope, target, write),
    ...write.rows.map(({ row, stored }) =>
      stored === null
        ? db
            .prepare(`INSERT INTO cron_checkins (monitor_id, environment, check_in_id, status,
                date_added, expected_at, timeout_at, completed_at, duration_ms)
              SELECT ?1, ?2, ?4, ?5, ?6, ?7, ?8, ?9, ?10 WHERE ${OWNED}`)
            .bind(
              ...scopeValues(scope),
              row.checkInId,
              row.status,
              row.dateAdded,
              row.expectedAt,
              row.timeoutAt,
              row.completedAt,
              row.durationMs,
            )
        : db
            .prepare(`UPDATE cron_checkins SET status = ?5, timeout_at = ?6, completed_at = ?7,
                duration_ms = ?8 WHERE id = ?4 AND ${OWNED}`)
            .bind(
              ...scopeValues(scope),
              stored.id,
              row.status,
              row.timeoutAt,
              row.completedAt,
              row.durationMs,
            ),
    ),
    // Keyed by the check-in row, so one outcome is recorded once. The insert
    // opens or resolves the issue through the monitor_observation_issue
    // trigger shared with metric and uptime monitors.
    ...write.decisions.map(({ outcome, row, health }) =>
      db
        .prepare(`INSERT INTO monitor_observations
            (monitor_id, evaluated_at, health, evidence, scope, severity, generation, slot)
          SELECT ?1, ?4, ?5, json_object('outcome', ?6, 'checkInId', ?7, 'expectedAt', ?8,
              'startedAt', ?9, 'completedAt', ?10, 'durationMs', ?11),
            ?2, CASE ?5 WHEN 'failing' THEN 'high' END, m.generation, c.id
          FROM monitors m JOIN cron_checkins c ON c.monitor_id = m.id AND c.check_in_id = ?7
          WHERE m.id = ?1 AND ${OWNED}`)
        .bind(
          ...scopeValues(scope),
          target.now,
          health,
          outcome,
          row.checkInId,
          row.expectedAt,
          row.status === "missed" ? null : row.dateAdded,
          row.completedAt,
          row.durationMs,
        ),
    ),
    db
      .prepare(`UPDATE monitors SET evaluated_at = ?4, health = (
          SELECT health FROM cron_environments WHERE monitor_id = ?1 ORDER BY CASE health
            WHEN 'failing' THEN 1 WHEN 'degraded' THEN 2 WHEN 'healthy' THEN 3 ELSE 4 END LIMIT 1)
        WHERE id = ?1 AND ${OWNED}`)
      .bind(...scopeValues(scope), target.now),
  ]);

  if (claimed === undefined) {
    throw new Error("D1 returned no result for the environment claim");
  }

  return claimed.meta.changes === 1;
}

type Scope = { db: D1Database; monitorId: string; environment: string; token: string };

// Every dependent statement binds the scope as ?1 to ?3.
const OWNED = `(SELECT write_token FROM cron_environments WHERE monitor_id = ?1 AND environment = ?2) = ?3`;

function scopeValues(scope: Scope): [string, string, string] {
  return [scope.monitorId, scope.environment, scope.token];
}

function claim(
  scope: Scope,
  target: Target & { read: EnvironmentRead },
  write: CronWrite,
): D1PreparedStatement {
  const { state, health } = write;

  const values = [
    state.status,
    health,
    state.lastCheckIn,
    state.nextCheckIn,
    state.nextCheckInLatest,
    state.lastDecided,
    state.failures,
    state.successes,
  ];

  if (target.read.exists) {
    return scope.db
      .prepare(`UPDATE cron_environments SET status = ?5, health = ?6, last_checkin = ?7,
          next_checkin = ?8, next_checkin_latest = ?9, last_decided = ?10, failures = ?11,
          successes = ?12, revision = revision + 1, write_token = ?3
        WHERE monitor_id = ?1 AND environment = ?2 AND revision = ?4`)
      .bind(...scopeValues(scope), target.read.revision, ...values);
  }

  return scope.db
    .prepare(`INSERT INTO cron_environments (monitor_id, environment, write_token, created_at,
        status, health, last_checkin, next_checkin, next_checkin_latest, last_decided,
        failures, successes, revision)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 1)
      ON CONFLICT DO NOTHING`)
    .bind(...scopeValues(scope), target.now, ...values);
}
