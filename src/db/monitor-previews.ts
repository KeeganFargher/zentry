import { jsonText } from "@/shared/json";
import { UptimeConfig } from "@/shared/monitors";

import type { ProbeRequest, ProbeResult } from "./uptime-monitors";

const Config = jsonText(UptimeConfig);

export class MonitorPreviews {
  readonly #db: D1Database;

  constructor(db: D1Database) {
    this.#db = db;
  }

  async create(
    id: string,
    input: ProbeRequest,
    { expiresAt, now, actorId }: { expiresAt: number; now: number; actorId: number },
  ): Promise<void> {
    await this.#db.batch([
      this.#db.prepare("DELETE FROM monitor_previews WHERE expires_at <= ?1").bind(now),
      this.#db
        .prepare(
          "INSERT INTO monitor_previews (id, organization_id, config, expires_at, actor_id) VALUES (?1, ?2, ?3, ?4, ?5)",
        )
        .bind(id, input.organizationId, JSON.stringify(input.config), expiresAt, actorId),
    ]);
  }

  get(
    organizationId: number,
    id: string,
  ): Promise<{ expiresAt: number; result: string | null } | null> {
    return this.#db
      .prepare(
        "SELECT expires_at AS expiresAt, result FROM monitor_previews WHERE organization_id = ?1 AND id = ?2",
      )
      .bind(organizationId, id)
      .first();
  }

  async start(id: string, now: number): Promise<ProbeRequest | null> {
    // The claim is permanent so redelivery cannot run a second request.
    const row = await this.#db
      .prepare(`UPDATE monitor_previews SET started_at = ?2
      WHERE id = ?1 AND expires_at > ?2 AND started_at IS NULL
      AND EXISTS (SELECT 1 FROM organization_members member
        WHERE member.organization_id = monitor_previews.organization_id
          AND member.user_id = monitor_previews.actor_id AND member.role = 'owner')
      RETURNING organization_id AS organizationId, config`)
      .bind(id, now)
      .first<{ organizationId: number; config: string }>();

    return row === null
      ? null
      : { organizationId: row.organizationId, config: Config.parse(row.config) };
  }

  async finish(id: string, result: ProbeResult, now: number): Promise<void> {
    await this.#db
      .prepare("UPDATE monitor_previews SET result = ?2 WHERE id = ?1 AND expires_at > ?3")
      .bind(id, JSON.stringify(result), now)
      .run();
  }
}
