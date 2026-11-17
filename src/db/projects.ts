// Projects and their DSN keys.

import type { RateLimitReason } from "@/shared/contract";

export type ProjectRecord = {
  id: number;
  slug: string;
  name: string;
  platform: string | null;
  maxEventsPerHour: number | null;
  rateLimit: { until: number; reason: RateLimitReason } | null;
  spikeProtection: boolean;
  spikeLimitPerHour: number | null;
  firstEventAt: number | null;
  createdAt: number;
};

type ProjectRow = Omit<ProjectRecord, "rateLimit" | "spikeProtection"> & {
  rateLimitedUntil: number | null;
  rateLimitReason: RateLimitReason | null;
  spikeProtection: number;
};

export type KeyRecord = {
  id: number;
  label: string;
  publicKey: string;
  status: "active" | "revoked";
  createdAt: number;
};

export type NewProject = {
  organizationId: number;
  slug: string;
  name: string;
  platform: string | null;
  publicKey: string;
  now: number;
};

export type ProjectChanges = {
  name: string;
  maxEventsPerHour: number | null;
  spikeProtection: boolean;
};

export type NewKey = { projectId: number; label: string; publicKey: string; now: number };

export type KeyChanges = {
  projectId: number;
  keyId: number;
  label: string;
  status: KeyRecord["status"];
};

export type ProjectHour = { projectId: number; bucket: number; received: number };

const PROJECT_COLUMNS = `
  id, slug, name, platform,
  max_events_per_hour AS maxEventsPerHour,
  rate_limited_until AS rateLimitedUntil,
  rate_limit_reason AS rateLimitReason,
  spike_protection AS spikeProtection,
  spike_limit_per_hour AS spikeLimitPerHour,
  first_event_at AS firstEventAt,
  created_at AS createdAt`;

function toRecord(row: ProjectRow): ProjectRecord {
  const { rateLimitedUntil, rateLimitReason, spikeProtection, ...rest } = row;

  // The table's CHECK keeps the two limit columns set and cleared together.
  const rateLimit =
    rateLimitedUntil === null || rateLimitReason === null
      ? null
      : { until: rateLimitedUntil, reason: rateLimitReason };

  return { ...rest, rateLimit, spikeProtection: spikeProtection === 1 };
}

const KEY_COLUMNS = `id, label, public_key AS publicKey, status, created_at AS createdAt`;

export class ProjectStore {
  readonly #db: D1Database;

  constructor(db: D1Database) {
    this.#db = db;
  }

  async list(organizationId: number): Promise<ProjectRecord[]> {
    const { results } = await this.#db
      .prepare(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE organization_id = ?1 ORDER BY slug`)
      .bind(organizationId)
      .all<ProjectRow>();

    return results.map(toRecord);
  }

  async findBySlug(organizationId: number, slug: string): Promise<ProjectRecord | null> {
    const row = await this.#db
      .prepare(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE organization_id = ?1 AND slug = ?2`)
      .bind(organizationId, slug)
      .first<ProjectRow>();

    return row === null ? null : toRecord(row);
  }

  /** Creates the project and its first key. Null when the slug is taken. */
  async create(project: NewProject): Promise<ProjectRecord | null> {
    const db = this.#db;

    if ((await this.findBySlug(project.organizationId, project.slug)) !== null) {
      return null;
    }

    await db.batch([
      db
        .prepare(
          `INSERT INTO projects (organization_id, slug, name, platform, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5)`,
        )
        .bind(project.organizationId, project.slug, project.name, project.platform, project.now),
      db
        .prepare(
          `INSERT INTO project_keys (project_id, public_key, created_at)
           SELECT id, ?3, ?4 FROM projects WHERE organization_id = ?1 AND slug = ?2`,
        )
        .bind(project.organizationId, project.slug, project.publicKey, project.now),
    ]);

    return this.findBySlug(project.organizationId, project.slug);
  }

  /**
   * A change to the quota or to spike protection lifts the current limit: it
   * was set under the old settings, and the next batch sets it again if the
   * new ones are still passed.
   */
  async update(projectId: number, changes: ProjectChanges): Promise<void> {
    const limitsChanged = `max_events_per_hour IS NOT ?3 OR spike_protection IS NOT ?4`;

    await this.#db
      .prepare(
        `UPDATE projects
         SET name = ?2,
             max_events_per_hour = ?3,
             spike_protection = ?4,
             rate_limited_until = CASE WHEN ${limitsChanged} THEN NULL ELSE rate_limited_until END,
             rate_limit_reason  = CASE WHEN ${limitsChanged} THEN NULL ELSE rate_limit_reason END
         WHERE id = ?1`,
      )
      .bind(projectId, changes.name, changes.maxEventsPerHour, changes.spikeProtection ? 1 : 0)
      .run();
  }

  /** Cascades to the project's keys, issues, events, tags and stats. */
  async delete(projectId: number): Promise<void> {
    await this.#db.prepare(`DELETE FROM projects WHERE id = ?1`).bind(projectId).run();
  }

  async listKeys(projectId: number): Promise<KeyRecord[]> {
    const { results } = await this.#db
      .prepare(`SELECT ${KEY_COLUMNS} FROM project_keys WHERE project_id = ?1 ORDER BY id`)
      .bind(projectId)
      .all<KeyRecord>();

    return results;
  }

  async createKey(key: NewKey): Promise<void> {
    await this.#db
      .prepare(
        `INSERT INTO project_keys (project_id, public_key, label, created_at) VALUES (?1, ?2, ?3, ?4)`,
      )
      .bind(key.projectId, key.publicKey, key.label, key.now)
      .run();
  }

  /** False when the key does not belong to the project. */
  async updateKey(changes: KeyChanges): Promise<boolean> {
    const result = await this.#db
      .prepare(`UPDATE project_keys SET label = ?3, status = ?4 WHERE id = ?2 AND project_id = ?1`)
      .bind(changes.projectId, changes.keyId, changes.label, changes.status)
      .run();

    return result.meta.changes > 0;
  }

  /** Hourly received counts for every project in the organization since `since`. */
  async hourlyCounts(organizationId: number, since: number): Promise<ProjectHour[]> {
    const { results } = await this.#db
      .prepare(
        `SELECT ps.project_id AS projectId, ps.bucket, ps.received
         FROM project_stats ps JOIN projects p ON p.id = ps.project_id
         WHERE p.organization_id = ?1 AND ps.bucket >= ?2`,
      )
      .bind(organizationId, since)
      .all<ProjectHour>();

    return results;
  }
}
