// The notify worker's reads and writes for routing a monitor transition to its
// alert rules (src/core/monitor-routing.ts decides). A transition is routed
// once: its delivery rows and its routed mark are written in one batch, and a
// retry finds it routed and only dispatches.

import { z } from "zod";

import { jsonText } from "@/shared/json";
import { MonitorRule } from "@/shared/monitor-alerts";
import type { Delivery, LinkedRule, RoutingInput } from "@/shared/monitor-routing";

const RuleConfig = jsonText(MonitorRule.omit({ name: true }));

const TransitionRow = z.object({
  type: z.enum(["failure", "escalation", "recovery"]),
  severity: z.enum(["medium", "high"]),
  happenedAt: z.int(),
  scope: z.string(),
  periodId: z.int().nullable(),
  notify: z.union([z.literal(0), z.literal(1)]).transform(Boolean),
  status: z.enum(["active", "paused", "archived"]),
  mutedUntil: z.int().nullable(),
  environment: z.string().nullable(),
  ruleIds: jsonText(z.array(z.uuid())),
  organizationId: z.int(),
  groupId: z.int().nullable(),
});

const PriorRow = z.object({
  ruleId: z.string(),
  channel: z.enum(["email", "push"]),
  type: z.enum(["failure", "escalation", "recovery"]),
  happenedAt: z.int(),
  periodId: z.int().nullable(),
});

const RuleRow = z.object({ id: z.string(), name: z.string(), config: z.string() });

export class MonitorRoutingStore {
  readonly #db: D1Database;

  constructor(db: D1Database) {
    this.#db = db;
  }

  /**
   * The scope's transitions up to this one that are not routed yet, oldest
   * first. Throttling, "already paged" and a high-priority rule's first
   * failure all read earlier deliveries, so a scope routes in order.
   */
  async unrouted(transitionId: number): Promise<number[]> {
    const { results } = await this.#db
      .prepare(`SELECT later.id FROM monitor_transitions this
        JOIN monitor_transitions later ON later.monitor_id = this.monitor_id AND later.scope = this.scope
        WHERE this.id = ?1 AND later.id <= ?1 AND later.routed_at IS NULL
        ORDER BY later.id`)
      .bind(transitionId)
      .all<{ id: number }>();

    return results.map(({ id }) => id);
  }

  /** What routing the transition reads; null once retention has pruned it. */
  async input(transitionId: number): Promise<RoutingInput | null> {
    const row = await this.#db
      .prepare(`SELECT t.type, json_extract(t.evidence, '$.severity') AS severity,
          t.happened_at AS happenedAt, t.scope, t.period_id AS periodId,
          m.notify, m.status, m.muted_until AS mutedUntil,
          json_extract(m.config, '$.environment') AS environment, m.alert_rule_ids AS ruleIds,
          p.organization_id AS organizationId,
          (SELECT id FROM groups WHERE monitor_id = m.id AND monitor_scope = t.scope) AS groupId
        FROM monitor_transitions t JOIN monitors m ON m.id = t.monitor_id
        JOIN projects p ON p.id = m.project_id
        WHERE t.id = ?1`)
      .bind(transitionId)
      .first();

    if (row === null) {
      return null;
    }

    const {
      ruleIds,
      organizationId,
      groupId,
      notify,
      status,
      mutedUntil,
      environment,
      ...transition
    } = TransitionRow.parse(row);

    return {
      transition,
      monitor: { notify, status, mutedUntil, environment },
      rules: await this.#rules(organizationId, ruleIds),
      priors: groupId === null ? [] : await this.#priors(groupId, transitionId),
      groupId,
    };
  }

  /** The linked rules, in the monitor's order; a rule since deleted is skipped. */
  async #rules(organizationId: number, ruleIds: string[]): Promise<LinkedRule[]> {
    const { results } = await this.#db
      .prepare(`SELECT id, name, config FROM monitor_alert_rules
        WHERE organization_id = ?1 AND id IN (SELECT value FROM json_each(?2))`)
      .bind(organizationId, JSON.stringify(ruleIds))
      .all();

    const rules = results.map((row) => {
      const { id, name, config } = RuleRow.parse(row);

      return Object.assign(RuleConfig.parse(config), { id, name });
    });

    return rules.toSorted((a, b) => ruleIds.indexOf(a.id) - ruleIds.indexOf(b.id));
  }

  /** The issue's earlier deliveries that were sent, with the incident each belonged to. */
  async #priors(groupId: number, transitionId: number): Promise<RoutingInput["priors"]> {
    const { results } = await this.#db
      .prepare(`SELECT d.rule_id AS ruleId, d.channel, d.transition_type AS type,
          d.happened_at AS happenedAt, t.period_id AS periodId
        FROM monitor_deliveries d JOIN monitor_transitions t ON t.id = d.transition_id
        WHERE d.group_id = ?1 AND d.suppression IS NULL AND d.transition_id < ?2`)
      .bind(groupId, transitionId)
      .all();

    return results.map((row) => PriorRow.parse(row));
  }

  /**
   * Writes the transition's deliveries and marks it routed, in one batch. A
   * transition whose issue is gone is marked routed with no deliveries.
   */
  async save(
    transitionId: number,
    route: { groupId: number | null; deliveries: Delivery[]; now: number },
  ): Promise<void> {
    const { groupId, deliveries, now } = route;

    const inserts =
      groupId === null
        ? []
        : deliveries.map(({ ruleId, channel, type, suppression }) =>
            this.#db
              .prepare(`INSERT INTO monitor_deliveries
                  (transition_id, group_id, rule_id, channel, happened_at, transition_type, suppression)
                SELECT ?1, ?2, ?3, ?4, happened_at, ?5, ?6 FROM monitor_transitions
                WHERE id = ?1 AND routed_at IS NULL
                ON CONFLICT DO NOTHING`)
              .bind(transitionId, groupId, ruleId, channel, type, suppression),
          );

    await this.#db.batch([
      ...inserts,
      this.#db
        .prepare(
          `UPDATE monitor_transitions SET routed_at = ?2 WHERE id = ?1 AND routed_at IS NULL`,
        )
        .bind(transitionId, now),
    ]);
  }

  /** The transition's deliveries that are to be sent. */
  async deliveries(transitionId: number): Promise<number[]> {
    const { results } = await this.#db
      .prepare(`SELECT id FROM monitor_deliveries
        WHERE transition_id = ?1 AND suppression IS NULL ORDER BY id`)
      .bind(transitionId)
      .all<{ id: number }>();

    return results.map(({ id }) => id);
  }

  async suppressAll(transitionId: number, reason: string): Promise<void> {
    await this.#db
      .prepare(`UPDATE monitor_deliveries SET suppression = ?2
        WHERE transition_id = ?1 AND suppression IS NULL`)
      .bind(transitionId, reason)
      .run();
  }
}
