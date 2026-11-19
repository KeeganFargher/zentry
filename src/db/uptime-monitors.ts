import { z } from "zod";

import { jsonText } from "@/shared/json";
import { logInfo } from "@/shared/log";
import type { IssuePlan, IssueState } from "@/shared/monitor-issues";
import { UptimeConfig } from "@/shared/monitors";
import type { ScheduledUptimeJob, UptimeSettings } from "@/shared/monitors";
import { MINUTE } from "@/shared/time";

import { issueStateOf, readIssueStates, scopeStatements } from "./monitor-issues";

type Claim = { slot: number; token: string; now: number };

export type ProbeResult = {
  outcome: "ok" | "failed" | "unknown";
  httpStatus?: number | undefined;
  durationMs?: number | undefined;
  reason?:
    | "policy"
    | "timeout"
    | "network"
    | "status"
    | "budget"
    | "paused"
    | "probe_unavailable"
    | undefined;
};

export type ProbeRequest = { config: UptimeSettings; organizationId: number };

const Config = jsonText(UptimeConfig);

const FinishingRow = z.object({
  health: z.string(),
  failures: z.int(),
  successes: z.int(),
  slot: z.int(),
  failureThreshold: z.int().positive(),
  recoveryThreshold: z.int().positive(),
  scope: z.string(),
});

/** A leased monitor as its check result is decided. */
export type UptimeFinishing = {
  scope: string;
  slot: number;
  streaks: Omit<z.output<typeof FinishingRow>, "scope" | "slot"> & { issueOpen: boolean };
  issue: IssueState;
};

/** A decided check: its result, the monitor's next streaks and health, and its issue plan. */
export type UptimeFinished = {
  result: ProbeResult;
  next: { health: string; failures: number; successes: number };
  plan: IssuePlan;
  scope: string;
  slot: number;
};

// The fence every statement after the claim carries: ?1 monitor, ?2 token.
const OWNED = `(SELECT write_token FROM monitors WHERE id = ?1) = ?2`;

// Probes leased per minute tick, overall and per organization.
const UPTIME_CLAIMS_PER_TICK = 100;
const UPTIME_CLAIMS_PER_ORGANIZATION = 25;

export class UptimeMonitorStore {
  readonly #db: D1Database;

  constructor(db: D1Database) {
    this.#db = db;
  }

  /**
   * Leases the uptime monitors due in this slot. The longest-unclaimed go
   * first and each organization gets at most UPTIME_CLAIMS_PER_ORGANIZATION
   * per tick, so a backlog rotates through every monitor instead of always
   * favouring the lowest IDs, and one organization cannot take every slot.
   */
  async claim(claim: Claim): Promise<{ id: string }[]> {
    await this.#markGaps(claim);

    const { results } = await this.#db
      .prepare(`
      UPDATE monitors SET lease_token = ?2, lease_expires = ?3, slot = ?1, probe_started = 0, claimed_at = ?1
      WHERE id IN (
        SELECT id FROM (
          SELECT m.id, m.claimed_at, ROW_NUMBER() OVER (
            PARTITION BY p.organization_id ORDER BY m.claimed_at IS NOT NULL, m.claimed_at, m.id
          ) AS turn
          FROM monitors m JOIN projects p ON p.id = m.project_id
          WHERE m.type = 'uptime' AND m.status = 'active' AND m.created_at <= ?1
            AND (m.lease_expires IS NULL OR m.lease_expires <= ?4)
            AND (m.evaluated_at IS NULL OR m.evaluated_at + json_extract(m.config,'$.intervalMinutes') * 60000 <= ?1)
        )
        WHERE turn <= ?5
        ORDER BY claimed_at IS NOT NULL, claimed_at, id LIMIT ?6
      )
      RETURNING id`)
      .bind(
        claim.slot,
        claim.token,
        claim.now + MINUTE,
        claim.now,
        UPTIME_CLAIMS_PER_ORGANIZATION,
        UPTIME_CLAIMS_PER_TICK,
      )
      .all<{ id: string }>();

    return results;
  }

  /**
   * Records an unknown check for every active monitor whose lease expired or
   * whose slot passed unclaimed, with its observation. Unknown never touches
   * the issue, so this needs no issue plan. A slot already observed (the
   * evaluated time did not move) is not observed twice.
   */
  async #markGaps(claim: Claim): Promise<void> {
    const token = crypto.randomUUID();

    await this.#db.batch([
      this.#db
        .prepare(`
      UPDATE monitors SET evaluated_at = CASE
          WHEN lease_expires <= ?2 AND slot >= ?1 THEN slot
          ELSE MAX(COALESCE(slot, 0), ?1 - json_extract(config,'$.intervalMinutes') * 60000) END,
        health = 'unknown', successes = 0, failures = 0, probe_started = 0,
        lease_token = NULL, lease_expires = NULL, write_token = ?3,
        last_result = json_object('outcome','unknown','reason','coverage_gap','skippedSlots',
          MAX(1, (?1 - COALESCE(evaluated_at,slot,?1)) / (json_extract(config,'$.intervalMinutes') * 60000) - 1))
      WHERE type = 'uptime' AND status = 'active'
        AND (lease_expires IS NULL OR lease_expires <= ?2)
        AND ((lease_expires IS NOT NULL AND lease_expires <= ?2)
          OR (evaluated_at IS NOT NULL AND evaluated_at + 2 * json_extract(config,'$.intervalMinutes') * 60000 <= ?1))
        AND (evaluated_at IS NULL OR evaluated_at < ?1)
    `)
        .bind(claim.slot, claim.now, token),
      this.#db
        .prepare(`INSERT INTO monitor_observations
            (monitor_id, evaluated_at, health, evidence, severity, generation, slot, scope)
          SELECT id, evaluated_at, health, last_result, severity, generation, evaluated_at,
            COALESCE(json_extract(config, '$.environment'), '')
          FROM monitors WHERE write_token = ?1 AND type = 'uptime'
          ON CONFLICT DO NOTHING`)
        .bind(token),
    ]);
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

  /** The leased monitor's streaks and issue, or null when the lease is no longer this job's. */
  async finishing(job: ScheduledUptimeJob, now: number): Promise<UptimeFinishing | null> {
    const row = await this.#db
      .prepare(`SELECT health, failures, successes, slot,
          json_extract(config, '$.failureThreshold') AS failureThreshold,
          json_extract(config, '$.recoveryThreshold') AS recoveryThreshold,
          COALESCE(json_extract(config, '$.environment'), '') AS scope
        FROM monitors WHERE id = ?1 AND lease_token = ?2 AND status = 'active' AND lease_expires > ?3`)
      .bind(job.id, job.token, now)
      .first();

    if (row === null) {
      return null;
    }

    const { scope, slot, ...streaks } = FinishingRow.parse(row);

    const issue = issueStateOf(await readIssueStates(this.#db, [job.id]), {
      monitorId: job.id,
      scope,
    });

    return {
      scope,
      slot,
      streaks: { ...streaks, issueOpen: issue.issue?.status === "unresolved" },
      issue,
    };
  }

  /**
   * Saves the check, its observation and its issue writes in one batch. The
   * first statement takes the leased monitor and stamps a token the others
   * check, since clearing the lease removes the lease as a fence.
   */
  async finish(job: ScheduledUptimeJob, finished: UptimeFinished, now: number): Promise<void> {
    const token = crypto.randomUUID();
    const { result, next, plan, scope, slot } = finished;
    const evidence = JSON.stringify(result);

    const issues = scopeStatements(this.#db, {
      monitorId: job.id,
      scope,
      fence: { sql: OWNED, values: [job.id, token] },
      observations: [
        {
          at: slot,
          health: next.health,
          severity: null,
          evidence,
          slot: { kind: "value", value: slot },
        },
      ],
      plan,
    });

    const results = await this.#db.batch([
      this.#db
        .prepare(`
      UPDATE monitors SET evaluated_at = slot, lease_expires = NULL, lease_token = NULL,
        last_result = ?4, failures = ?5, successes = ?6, health = ?7, write_token = ?8
      WHERE id = ?1 AND lease_token = ?2 AND status = 'active' AND lease_expires > ?3`)
        .bind(job.id, job.token, now, evidence, next.failures, next.successes, next.health, token),
      ...issues.statements,
    ]);

    const won = results[0]?.meta.changes === 1;
    const issueClaim = issues.claim === null ? undefined : results[1 + issues.claim];

    // The check won but a user changed the issue in the same instant; the next
    // check plans against the issue as it is now.
    if (won && issueClaim !== undefined && issueClaim.meta.changes === 0) {
      logInfo("monitor issue changed during its write", { monitorId: job.id });
    }
  }
}
