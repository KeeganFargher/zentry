// Each organization's monthly event count, read by ingest for the monthly cap.

export class UsageStore {
  readonly #db: D1Database;

  constructor(db: D1Database) {
    this.#db = db;
  }

  /** Events accepted in the month starting at `month`; 0 before the first one. */
  async received(organizationId: number, month: number): Promise<number> {
    const row = await this.#db
      .prepare(`SELECT received FROM usage_months WHERE organization_id = ?1 AND month = ?2`)
      .bind(organizationId, month)
      .first<{ received: number }>();

    return row?.received ?? 0;
  }
}
