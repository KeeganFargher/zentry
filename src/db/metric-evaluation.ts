// Metric monitor evaluation: read each due monitor's next state, then write it
// with its observation and planned issue lifecycle (src/core/monitor-issues.ts)
// in one batch. Each monitor's statements are fenced by a compare-and-swap on
// its evaluated_at and generation: two ticks reading the same window write it
// once, and an edit or resume between the read and the write (which resets
// evaluated_at to NULL and bumps the generation) discards the stale window.

import { z } from "zod";

import { logInfo } from "@/shared/log";
import type { IssuePlan, IssueState } from "@/shared/monitor-issues";

import { evaluateMetricQuery } from "./metric-query";
import { readIssueStates, scopeStatements } from "./monitor-issues";

const MetricDecision = z.object({
  monitorId: z.uuid(),
  previous: z.int().nullable(),
  generation: z.int(),
  severity: z.enum(["medium", "high"]).nullable(),
  scope: z.string(),
  evidence: z.string(),
  health: z.enum(["awaiting_data", "unknown", "failing", "healthy"]),
});

export type MetricDecision = z.output<typeof MetricDecision>;

export type PlannedMetric = { decision: MetricDecision; plan: IssuePlan };

/** One monitor's statements, and where its issue claim is among them. */
type MetricStatements = {
  decision: MetricDecision;
  statements: D1PreparedStatement[];
  issueClaim: number | null;
};

// The fence every statement after a monitor's claim carries: ?1 monitor, ?2 token.
const OWNED = `(SELECT write_token FROM monitors WHERE id = ?1) = ?2`;

export class MetricEvaluationStore {
  readonly #db: D1Database;

  constructor(db: D1Database) {
    this.#db = db;
  }

  /** The next state of each metric monitor due for the window ending at `windowEnd`. */
  async due(windowEnd: number): Promise<MetricDecision[]> {
    const { results } = await this.#db.prepare(evaluateMetricQuery).bind(windowEnd).all();

    return results.map((row) => MetricDecision.parse(row));
  }

  async issueStates(monitorIds: string[]): Promise<Map<string, IssueState>> {
    return readIssueStates(this.#db, monitorIds);
  }

  /** Every monitor's claim, observation and issue writes, in one batch. */
  async write(windowEnd: number, planned: PlannedMetric[]): Promise<void> {
    const parts = planned.map((entry) => this.#statements(windowEnd, entry));
    const results = await this.#db.batch(parts.flatMap(({ statements }) => statements));
    let offset = 0;

    for (const { decision, statements, issueClaim } of parts) {
      const won = results[offset]?.meta.changes === 1;
      const issue = issueClaim === null ? undefined : results[offset + issueClaim];

      // The window won but the issue moved under it (see src/db/monitor-issues.ts);
      // the next window plans against the issue as it is now.
      if (won && issue !== undefined && issue.meta.changes === 0) {
        logInfo("monitor issue changed during its write", { monitorId: decision.monitorId });
      }

      offset += statements.length;
    }
  }

  #statements(windowEnd: number, { decision, plan }: PlannedMetric): MetricStatements {
    const token = crypto.randomUUID();
    const { monitorId, previous, generation, severity, evidence, health, scope } = decision;

    const claim = this.#db
      .prepare(`UPDATE monitors SET evaluated_at = ?3, severity = ?4, last_result = ?5,
          health = ?6, write_token = ?2
        WHERE id = ?1 AND type = 'metric' AND status = 'active' AND evaluated_at IS ?7
          AND generation = ?8`)
      .bind(monitorId, token, windowEnd, severity, evidence, health, previous, generation);

    const issues = scopeStatements(this.#db, {
      monitorId,
      scope,
      fence: { sql: OWNED, values: [monitorId, token] },
      observations: [
        { at: windowEnd, health, severity, evidence, slot: { kind: "value", value: windowEnd } },
      ],
      plan,
    });

    return {
      decision,
      statements: [claim, ...issues.statements],
      issueClaim: issues.claim === null ? null : 1 + issues.claim,
    };
  }
}
