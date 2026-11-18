// Retention statements for the daily cron. Each deletes one bounded chunk and
// reports how many rows it removed, so the caller can loop within a time budget.

const EVENT_CHUNK = 5000;
const TAG_CHUNK = 5000;
const STATS_CHUNK = 5000;

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

  // Both stats tables are keyed by owner first, so finding expired buckets
  // scans the table. An index on `bucket` would avoid that, but it would cost a
  // write on every event to save a once-a-day scan of a small table.
  async deleteGroupStatsBefore(cutoff: number): Promise<number> {
    return this.#changes(
      `DELETE FROM group_stats WHERE (group_id, bucket) IN (
         SELECT group_id, bucket FROM group_stats WHERE bucket < ?1 LIMIT ?2)`,
      cutoff,
      STATS_CHUNK,
    );
  }

  async deleteProjectStatsBefore(cutoff: number): Promise<number> {
    return this.#changes(
      `DELETE FROM project_stats WHERE (project_id, bucket) IN (
         SELECT project_id, bucket FROM project_stats WHERE bucket < ?1 LIMIT ?2)`,
      cutoff,
      STATS_CHUNK,
    );
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

  /** Sent-email records only stop redeliveries sending twice; old ones serve nothing. */
  async deleteEmailSendsBefore(cutoff: number): Promise<number> {
    return this.#changes(
      `DELETE FROM email_sends WHERE key IN (
         SELECT key FROM email_sends WHERE created_at < ?1 ORDER BY created_at LIMIT ?2)`,
      cutoff,
      STATS_CHUNK,
    );
  }

  /** As email_sends: they stop a redelivery pushing twice, and old ones serve nothing. */
  async deletePushSendsBefore(cutoff: number): Promise<number> {
    return this.#changes(
      `DELETE FROM push_sends WHERE key IN (
         SELECT key FROM push_sends WHERE created_at < ?1 ORDER BY created_at LIMIT ?2)`,
      cutoff,
      STATS_CHUNK,
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
