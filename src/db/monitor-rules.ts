import { jsonText } from "@/shared/json";
import { MonitorRule } from "@/shared/monitor-alerts";
import type { ApiMonitorRule, NewMonitorRule } from "@/shared/monitor-alerts";

const Config = jsonText(MonitorRule.omit({ name: true }));

type RuleRow = {
  id: string;
  name: string;
  config: string;
  version: number;
  lastTriggered: number | null;
};

const LAST_TRIGGERED = `(SELECT MAX(happened_at) FROM monitor_deliveries d
  WHERE d.rule_id = monitor_alert_rules.id AND d.suppression IS NULL) AS lastTriggered`;

type RuleEdit = { id: string; version: number; rule: NewMonitorRule };

function rule({ id, name, config, version, lastTriggered }: RuleRow): ApiMonitorRule {
  return { id, name, version, lastTriggered, ...Config.parse(config) };
}

export class MonitorRuleStore {
  readonly #db: D1Database;

  constructor(db: D1Database) {
    this.#db = db;
  }

  async list(org: number): Promise<ApiMonitorRule[]> {
    const { results } = await this.#db
      .prepare(`
      SELECT id, name, config, version, ${LAST_TRIGGERED} FROM monitor_alert_rules WHERE organization_id = ?1
      ORDER BY name COLLATE NOCASE, id LIMIT 100`)
      .bind(org)
      .all<RuleRow>();

    return results.map(rule);
  }

  async create(org: number, { name, ...settings }: NewMonitorRule): Promise<ApiMonitorRule | null> {
    const row = await this.#db
      .prepare(`
      INSERT INTO monitor_alert_rules(id, organization_id, name, config)
      SELECT ?1, ?2, ?3, ?4 WHERE (SELECT COUNT(*) FROM monitor_alert_rules WHERE organization_id = ?2) < 100
      RETURNING id, name, config, version, NULL AS lastTriggered`)
      .bind(crypto.randomUUID(), org, name, JSON.stringify(settings))
      .first<RuleRow>();

    return row === null ? null : rule(row);
  }

  async update(
    org: number,
    { id, version, rule: { name, ...settings } }: RuleEdit,
  ): Promise<ApiMonitorRule | null> {
    const row = await this.#db
      .prepare(`
      UPDATE monitor_alert_rules SET name = ?4, config = ?5, version = version + 1
      WHERE id = ?1 AND organization_id = ?2 AND version = ?3
      RETURNING id, name, config, version, ${LAST_TRIGGERED}`)
      .bind(id, org, version, name, JSON.stringify(settings))
      .first<RuleRow>();

    return row === null ? null : rule(row);
  }
}
