// Retention statements for the daily cron. Each deletes one bounded chunk and
// reports how many rows it removed, so the caller can loop within a time budget.

const EVENT_CHUNK = 5000;
const TAG_CHUNK = 5000;

export type StatsCutoffs = { groupStatsBefore: number; projectStatsBefore: number };

export class RetentionStore {
  readonly #db: D1Database;

  constructor(db: D1Database) {
    this.#db = db;
  }

  async #changes(sql: string, ...binds: number[]): Promise<number> {
    const result = await this.#db
      .prepare(sql)
      .bind(...binds)
      .run();

    return result.meta.changes;
  }

  async deleteEventsBefore(cutoff: number): Promise<number> {
    return this.#changes(
      `DELETE FROM events WHERE (project_id, event_id) IN (
         SELECT project_id, event_id FROM events
         WHERE received_at < ?1 ORDER BY received_at LIMIT ?2)`,
      cutoff,
      EVENT_CHUNK,
    );
  }

  async deleteStatsBefore(cutoffs: StatsCutoffs): Promise<number> {
    const groups = await this.#changes(
      `DELETE FROM group_stats WHERE bucket < ?1`,
      cutoffs.groupStatsBefore,
    );

    const projects = await this.#changes(
      `DELETE FROM project_stats WHERE bucket < ?1`,
      cutoffs.projectStatsBefore,
    );

    return groups + projects;
  }

  /** Keeps the `keep` most-seen values of each tag key per issue. */
  async pruneTags(keep: number): Promise<number> {
    return this.#changes(
      `DELETE FROM group_tag_values WHERE (group_id, key, value) IN (
         SELECT group_id, key, value FROM (
           SELECT group_id, key, value,
                  ROW_NUMBER() OVER (PARTITION BY group_id, key ORDER BY times_seen DESC) AS position
           FROM group_tag_values
           WHERE (group_id, key) IN (
             SELECT group_id, key FROM group_tag_values GROUP BY group_id, key HAVING count(*) > ?1)
         ) WHERE position > ?1 LIMIT ?2)`,
      keep,
      TAG_CHUNK,
    );
  }

  async clearExpiredLimits(now: number): Promise<number> {
    return this.#changes(
      `UPDATE projects SET rate_limited_until = NULL, rate_limit_reason = NULL
       WHERE rate_limited_until < ?1`,
      now,
    );
  }
}
