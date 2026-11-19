// Writes a monitor scope's observations and the issue lifecycle planned for
// them (src/core/monitor-issues.ts) as statements for the writer's own batch.
//
// Every statement carries the writer's fence (the cron environment's token,
// the monitor's token for metric and uptime), so a writer that lost its race
// writes nothing. The issue writes also carry a claim on the issue row itself:
// the first issue statement stamps a fresh token only if the issue is still in
// the state that was planned against, and every later one checks that token.
// A user resolving the issue in the instant between read and write therefore
// costs this batch its issue writes, never a corrupt issue; the next
// observation plans against the new state. Rows written earlier in the batch
// are found by natural key, never last_insert_rowid(), which goes stale when a
// fenced insert is skipped.

import { z } from "zod";

import type { IssueChange, IssuePlan, IssueState } from "@/shared/monitor-issues";
import { NO_ISSUE } from "@/shared/monitor-issues";

type Bind = string | number | null;

/** A condition with its own ?1..?n parameters that a writer's batch still owns its scope. */
export type Fence = { sql: string; values: Bind[] };

/** How an observation's row is found again: its slot value, or its cron check-in. */
export type Slot = { kind: "value"; value: number } | { kind: "checkIn"; checkInId: string };

export type ObservationWrite = {
  at: number;
  health: string;
  severity: "medium" | "high" | null;
  evidence: string;
  slot: Slot;
};

export type ScopeKey = { monitorId: string; scope: string };

export type ScopeWrite = ScopeKey & {
  fence: Fence;
  observations: ObservationWrite[];
  plan: IssuePlan;
};

/** The scope's statements, and where its issue claim is among them (null when it writes no issue). */
export type ScopeStatements = { statements: D1PreparedStatement[]; claim: number | null };

const IssueRow = z.object({
  monitorId: z.string(),
  scope: z.string(),
  status: z.enum(["unresolved", "resolved", "ignored"]),
  level: z.string(),
  timesSeen: z.int(),
  periodOpen: z.union([z.literal(0), z.literal(1)]).transform(Boolean),
});

export function scopeKey({ monitorId, scope }: ScopeKey): string {
  return `${monitorId}\u0000${scope}`;
}

/** The issue state of each scope, keyed by scopeKey; a scope with no issue is absent. */
export async function readIssueStates(
  db: D1Database,
  monitorIds: string[],
): Promise<Map<string, IssueState>> {
  const { results } = await db
    .prepare(`SELECT g.monitor_id AS monitorId, g.monitor_scope AS scope, g.status, g.level,
        g.times_seen AS timesSeen,
        EXISTS (SELECT 1 FROM monitor_periods WHERE group_id = g.id AND closed_at IS NULL) AS periodOpen
      FROM groups g WHERE g.monitor_id IN (SELECT value FROM json_each(?1))`)
    .bind(JSON.stringify(monitorIds))
    .all();

  return new Map(
    results.map((row) => {
      const { status, level, timesSeen, periodOpen, ...key } = IssueRow.parse(row);

      return [scopeKey(key), { issue: { status, level, timesSeen }, periodOpen }];
    }),
  );
}

export function issueStateOf(states: Map<string, IssueState>, key: ScopeKey): IssueState {
  return states.get(scopeKey(key)) ?? NO_ISSUE;
}

// Statement SQL numbers its own parameters $1..$n after the fence's; $1 is the
// monitor, $2 the scope and $3 the issue token in every statement.
const ISSUE = `(SELECT id FROM groups WHERE monitor_id = $1 AND monitor_scope = $2)`;
const OWNS_ISSUE = `(SELECT monitor_write_token FROM groups WHERE monitor_id = $1 AND monitor_scope = $2) = $3`;

type Builder = { db: D1Database; key: ScopeKey; fence: Fence; token: string };

function statement(builder: Builder, sql: string, values: Bind[]): D1PreparedStatement {
  const { db, key, fence, token } = builder;
  const offset = fence.values.length;

  const used = Math.max(...[...sql.matchAll(/\$(\d+)/gu)].map((match) => Number(match[1])));

  const text = sql
    .replaceAll("FENCE", `(${fence.sql})`)
    .replaceAll(/\$(\d+)/gu, (_, index: string) => `?${offset + Number(index)}`);

  // D1 refuses more values than the statement has parameters, so bind only up
  // to the highest one it uses; a statement need not name the issue token.
  const own = [key.monitorId, key.scope, token, ...values].slice(0, used);

  return db.prepare(text).bind(...fence.values, ...own);
}

/** The slot's SQL, bound as $n: a value, or the check-in row's id. */
function slotSql(slot: Slot, n: number): string {
  return slot.kind === "value"
    ? `$${n}`
    : `(SELECT id FROM cron_checkins WHERE monitor_id = $1 AND check_in_id = $${n})`;
}

function slotValue(slot: Slot): Bind {
  return slot.kind === "value" ? slot.value : slot.checkInId;
}

function observationSql(slot: Slot, n: number): string {
  return `(SELECT id FROM monitor_observations WHERE monitor_id = $1 AND scope = $2
    AND generation = (SELECT generation FROM monitors WHERE id = $1) AND slot = ${slotSql(slot, n)})`;
}

function insertObservation(builder: Builder, observation: ObservationWrite): D1PreparedStatement {
  const { at, health, evidence, severity, slot } = observation;

  return statement(
    builder,
    `INSERT INTO monitor_observations
        (monitor_id, evaluated_at, health, evidence, scope, severity, generation, slot)
      SELECT $1, $4, $5, $6, $2, $7, m.generation, ${slotSql(slot, 8)}
      FROM monitors m WHERE m.id = $1 AND FENCE`,
    [at, health, evidence, severity, slotValue(slot)],
  );
}

/**
 * Takes the issue for this batch: creates it if the plan expected none, or
 * stamps the token if it is still as read. Either way, a miss writes nothing.
 */
function claimIssue(
  builder: Builder,
  state: IssueState,
  first: { change: IssueChange; at: number },
): D1PreparedStatement[] {
  if (state.issue !== null) {
    const { status, level, timesSeen } = state.issue;

    return [
      statement(
        builder,
        `UPDATE groups SET monitor_write_token = $3
        WHERE monitor_id = $1 AND monitor_scope = $2 AND status = $4 AND level = $5
          AND times_seen = $6 AND FENCE`,
        [status, level, timesSeen],
      ),
    ];
  }

  const { change, at } = first;

  if (change.createIssue === null) {
    throw new Error("an issue change with no issue must create one");
  }

  return [
    statement(
      builder,
      `UPDATE projects SET next_short_id = next_short_id + 1
      WHERE id = (SELECT project_id FROM monitors WHERE id = $1) AND FENCE
        AND NOT EXISTS (SELECT 1 FROM groups WHERE monitor_id = $1 AND monitor_scope = $2)`,
      [],
    ),
    statement(
      builder,
      `INSERT INTO groups (project_id, short_id, primary_hash, title, level, metadata, status,
          times_seen, first_seen, last_seen, created_at, monitor_id, monitor_scope, monitor_write_token)
        SELECT p.id, p.next_short_id, 'monitor:' || m.id || ':' || $2, m.name, $4,
          json_object('type', m.type, 'value', NULL, 'function', NULL, 'filename', NULL, 'logger', NULL),
          'unresolved', 0, $5, $5, $5, m.id, $2, $3
        FROM monitors m JOIN projects p ON p.id = m.project_id
        WHERE m.id = $1 AND FENCE
        ON CONFLICT DO NOTHING`,
      [change.createIssue.level, at],
    ),
  ];
}

function transitionStatements(
  builder: Builder,
  observation: ObservationWrite,
  transition: NonNullable<IssueChange["transition"]>,
): D1PreparedStatement[] {
  const { at, slot } = observation;

  return [
    // Only an active monitor's transitions alert; a paused one still records its issue.
    statement(
      builder,
      `INSERT INTO monitor_transitions
          (observation_id, generation, period_id, monitor_id, scope, happened_at, type, evidence)
        SELECT o.id, o.generation,
          (SELECT id FROM monitor_periods WHERE group_id = ${ISSUE} AND closed_at IS NULL),
          $1, $2, $4, $5, json_set(o.evidence, '$.severity', $6)
        FROM monitor_observations o
        WHERE o.id = ${observationSql(slot, 7)}
          AND EXISTS (SELECT 1 FROM monitors WHERE id = $1 AND status = 'active')
          AND FENCE AND ${OWNS_ISSUE}`,
      [at, transition.type, transition.severity, slotValue(slot)],
    ),
    // The notify worker routes the transition to its alert rules.
    statement(
      builder,
      `INSERT INTO notify_outbox (kind, organization_id, project_id, group_id, data, created_at)
        SELECT 'status', p.organization_id, m.project_id, ${ISSUE},
          json_object('monitorTransitionId', t.id), $4
        FROM monitor_transitions t JOIN monitors m ON m.id = t.monitor_id
        JOIN projects p ON p.id = m.project_id
        WHERE t.observation_id = ${observationSql(slot, 5)} AND FENCE AND ${OWNS_ISSUE}`,
      [at, slotValue(slot)],
    ),
  ];
}

function updateIssue(
  builder: Builder,
  observation: ObservationWrite,
  update: NonNullable<IssueChange["update"]>,
): D1PreparedStatement {
  if (update.kind === "healthy") {
    return statement(
      builder,
      `UPDATE groups SET status = 'resolved', substatus = NULL, resolved_at = $4, resolved_by = NULL
      WHERE monitor_id = $1 AND monitor_scope = $2 AND FENCE AND ${OWNS_ISSUE}`,
      [observation.at],
    );
  }

  return statement(
    builder,
    `UPDATE groups SET status = 'unresolved',
        substatus = CASE WHEN $4 THEN 'regressed' ELSE substatus END,
        level = $5, resolved_at = NULL, resolved_by = NULL,
        last_seen = CASE WHEN $6 THEN $7 ELSE last_seen END,
        times_seen = times_seen + $6
      WHERE monitor_id = $1 AND monitor_scope = $2 AND FENCE AND ${OWNS_ISSUE}`,
    [Number(update.regressed), update.level, Number(update.sighted), observation.at],
  );
}

/** One observation's issue writes, in the order IssueChange documents. */
function changeStatements(
  builder: Builder,
  observation: ObservationWrite,
  change: IssueChange,
): D1PreparedStatement[] {
  const { at, evidence } = observation;
  const statements: D1PreparedStatement[] = [];

  if (change.activity !== null) {
    statements.push(
      statement(
        builder,
        `INSERT INTO activity (group_id, project_id, type, data, created_at)
        SELECT id, project_id, $4, $5, $6 FROM groups
        WHERE monitor_id = $1 AND monitor_scope = $2 AND FENCE AND ${OWNS_ISSUE}`,
        [change.activity, evidence, at],
      ),
    );
  }

  if (change.openPeriod) {
    statements.push(
      statement(
        builder,
        `INSERT INTO monitor_periods (group_id, opened_at, evidence)
        SELECT ${ISSUE}, $4, $5 WHERE FENCE AND ${OWNS_ISSUE}`,
        [at, evidence],
      ),
    );
  }

  if (change.transition !== null) {
    statements.push(...transitionStatements(builder, observation, change.transition));
  }

  if (change.closePeriod) {
    statements.push(
      statement(
        builder,
        `UPDATE monitor_periods SET closed_at = $4, disposition = 'recovered'
        WHERE group_id = ${ISSUE} AND closed_at IS NULL AND FENCE AND ${OWNS_ISSUE}`,
        [at],
      ),
    );
  }

  if (change.update !== null) {
    statements.push(updateIssue(builder, observation, change.update));
  }

  return statements;
}

/** A scope's observations, then its issue claim and each observation's issue writes. */
export function scopeStatements(db: D1Database, write: ScopeWrite): ScopeStatements {
  const { fence, observations, plan } = write;

  if (observations.length !== plan.changes.length) {
    throw new Error("an issue plan must have one change per observation");
  }

  const builder = { db, key: write, fence, token: crypto.randomUUID() };
  const statements = observations.map((observation) => insertObservation(builder, observation));
  const first = plan.changes.findIndex((change) => change !== null);
  const firstChange = plan.changes[first];
  const firstObservation = observations[first];

  if (firstChange === undefined || firstChange === null || firstObservation === undefined) {
    return { statements, claim: null };
  }

  const claims = claimIssue(builder, plan.state, {
    change: firstChange,
    at: firstObservation.at,
  });

  // The claim is the last of its statements: the update, or the issue's insert.
  const claim = statements.length + claims.length - 1;

  statements.push(...claims);

  observations.forEach((observation, index) => {
    const change = plan.changes[index];

    if (change !== undefined && change !== null) {
      statements.push(...changeStatements(builder, observation, change));
    }
  });

  return { statements, claim };
}

/**
 * Closes a monitor's open incidents and resolves its issues, without an alert:
 * a config change means the old evidence no longer answers the new question,
 * and an archived monitor is gone. Applies only if the batch's monitor update
 * won, which stamped `token`.
 */
export function invalidationStatements(
  db: D1Database,
  change: { id: string; token: string; time: number },
): D1PreparedStatement[] {
  const { id, token, time } = change;

  return [
    db
      .prepare(`UPDATE monitor_periods SET closed_at = ?3, disposition = 'configuration_changed'
        WHERE closed_at IS NULL AND group_id IN (SELECT id FROM groups WHERE monitor_id = ?1)
          AND (SELECT write_token FROM monitors WHERE id = ?1) = ?2`)
      .bind(id, token, time),
    db
      .prepare(`UPDATE groups SET status = 'resolved', substatus = NULL, resolved_at = ?3
        WHERE monitor_id = ?1 AND status = 'unresolved'
          AND (SELECT write_token FROM monitors WHERE id = ?1) = ?2`)
      .bind(id, token, time),
  ];
}
