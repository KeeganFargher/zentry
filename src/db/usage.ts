// The installation-wide monthly event count, read by ingest for the monthly cap.

export class UsageStore {
  readonly #db: D1Database;

  constructor(db: D1Database) {
    this.#db = db;
  }

  /** Events accepted in the month starting at `month`; 0 before the first one. */
  async received(month: number): Promise<number> {
    const row = await this.#db
      .prepare(`SELECT received FROM usage_months WHERE month = ?1`)
      .bind(month)
      .first<{ received: number }>();

    return row?.received ?? 0;
  }
}
