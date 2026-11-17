// An organization's spend settings: its monthly cap and what it has used.

export type OrganizationLimits = {
  maxEventsPerMonth: number;
  projectCount: number;
  monthReceived: number;
};

export class OrganizationStore {
  readonly #db: D1Database;

  constructor(db: D1Database) {
    this.#db = db;
  }

  /** Throws for an unknown organization: callers have already resolved it. */
  async limits(organizationId: number, month: number): Promise<OrganizationLimits> {
    const row = await this.#db
      .prepare(
        `SELECT o.max_events_per_month AS maxEventsPerMonth,
                (SELECT count(*) FROM projects WHERE organization_id = o.id) AS projectCount,
                COALESCE((SELECT received FROM usage_months
                          WHERE organization_id = o.id AND month = ?2), 0) AS monthReceived
         FROM organizations o WHERE o.id = ?1`,
      )
      .bind(organizationId, month)
      .first<OrganizationLimits>();

    if (row === null) {
      throw new Error(`organization ${organizationId} does not exist`);
    }

    return row;
  }

  /**
   * Ingest sees the new cap within a minute (its key cache). Spike floors,
   * which derive from it, follow at the next hourly run.
   */
  async setMaxEventsPerMonth(organizationId: number, maxEventsPerMonth: number): Promise<void> {
    await this.#db
      .prepare(`UPDATE organizations SET max_events_per_month = ?2 WHERE id = ?1`)
      .bind(organizationId, maxEventsPerMonth)
      .run();
  }
}
