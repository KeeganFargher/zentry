import type { Decision, EnvironmentState, PlannedCronWrite } from "@/shared/cron";
import { logInfo } from "@/shared/log";
import type { IssueState } from "@/shared/monitor-issues";

import { scopeStatements } from "./monitor-issues";
import type { ObservationWrite } from "./monitor-issues";

/** An environment as read, with the revision a write must still match, and its issue. */
export type EnvironmentRead = {
  exists: boolean;
  revision: number;
  state: EnvironmentState;
  issue: IssueState;
};

export type Target = { monitorId: string; environment: string; now: number };

/** Decides what to write from a fresh read; null when there is nothing to write. */
export type Plan = (read: EnvironmentRead) => Promise<PlannedCronWrite | null>;

/** A decided outcome as the environment's observation, found again by its check-in. */
function observationOf(decision: Decision, now: number): ObservationWrite {
  const { outcome, row, health } = decision;

  return {
    at: now,
    health,
    severity: health === "failing" ? "high" : null,
    evidence: JSON.stringify({
      outcome,
      checkInId: row.checkInId,
      expectedAt: row.expectedAt,
      startedAt: row.status === "missed" ? null : row.dateAdded,
      completedAt: row.completedAt,
      durationMs: row.durationMs,
    }),
    slot: { kind: "checkIn", checkInId: row.checkInId },
  };
}

/**
 * One environment's new state, its check-in rows, history and issue writes for
 * each decided outcome, and the monitor's overall health, in one batch. The first
 * statement claims the revision that was read and stamps a fresh token;
 * every other statement checks that token, so a lost race changes nothing.
 * Returns whether the claim won.
 */
export async function writeEnvironment(
  db: D1Database,
  target: Target & { read: EnvironmentRead },
  write: PlannedCronWrite,
): Promise<boolean> {
  const token = crypto.randomUUID();
  const scope = { db, monitorId: target.monitorId, environment: target.environment, token };

  // The observations and issue writes carry the environment's token as their fence.
  const issues = scopeStatements(db, {
    monitorId: target.monitorId,
    scope: target.environment,
    fence: { sql: OWNED, values: scopeValues(scope) },
    observations: write.decisions.map((decision) => observationOf(decision, target.now)),
    plan: write.issues,
  });

  const rows = rowStatements(scope, write);

  const results = await db.batch([
    claim(scope, target, write),
    ...rows,
    ...issues.statements,
    db
      .prepare(`UPDATE monitors SET evaluated_at = ?4, health = (
          SELECT health FROM cron_environments WHERE monitor_id = ?1 ORDER BY CASE health
            WHEN 'failing' THEN 1 WHEN 'degraded' THEN 2 WHEN 'healthy' THEN 3 ELSE 4 END LIMIT 1)
        WHERE id = ?1 AND ${OWNED}`)
      .bind(...scopeValues(scope), target.now),
  ]);

  const [claimed] = results;

  if (claimed === undefined) {
    throw new Error("D1 returned no result for the environment claim");
  }

  const won = claimed.meta.changes === 1;

  const issueClaim = issues.claim === null ? undefined : results[1 + rows.length + issues.claim];

  if (won && issueClaim !== undefined && issueClaim.meta.changes === 0) {
    reportLostIssue(target);
  }

  return won;
}

/**
 * The environment won but its issue moved under it (a user resolved or
 * ignored it in the same instant): this batch's issue writes were skipped, and
 * the next observation plans against the issue as it is now.
 */
function reportLostIssue(target: Target): void {
  logInfo("monitor issue changed during its write", {
    monitorId: target.monitorId,
    scope: target.environment,
  });
}

function rowStatements(scope: Scope, write: PlannedCronWrite): D1PreparedStatement[] {
  const { db } = scope;

  return write.rows.map(({ row, stored }) =>
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
  );
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
  write: PlannedCronWrite,
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
