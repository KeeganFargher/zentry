// Issue summaries written by Workers AI for pushes. DESIGN.md §19.2.

import type { IssueSummary } from "@/shared/notify";

export type IssueSummaryRow = IssueSummary & {
  groupId: number;
  promptVersion: number;
  model: string;
  /** The event it was written from; null when it was written from the issue alone. */
  eventId: string | null;
  createdAt: number;
};

export class IssueSummaryStore {
  readonly #db: D1Database;

  constructor(db: D1Database) {
    this.#db = db;
  }

  /** The issue's summary, unless it was written by another prompt version. */
  async get(groupId: number, promptVersion: number): Promise<IssueSummary | null> {
    return this.#db
      .prepare(
        `SELECT headline, detail FROM issue_summaries WHERE group_id = ?1 AND prompt_version = ?2`,
      )
      .bind(groupId, promptVersion)
      .first<IssueSummary>();
  }

  /** Replaces the issue's summary, which may be from an older prompt version. */
  async put(row: IssueSummaryRow): Promise<void> {
    await this.#db
      .prepare(
        `INSERT OR REPLACE INTO issue_summaries
           (group_id, prompt_version, model, headline, detail, event_id, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      )
      .bind(
        row.groupId,
        row.promptVersion,
        row.model,
        row.headline,
        row.detail,
        row.eventId,
        row.createdAt,
      )
      .run();
  }
}
