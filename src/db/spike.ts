// Statements for the hourly spike-protection cron (DESIGN.md §6).

export type SpikeHour = { projectId: number; bucket: number; received: number };

export type SpikeLimit = { p: number; limit: number };

export type SpikeInput = {
  /** Every project, protected or not: the floor depends on how many there are. */
  projectCount: number;
  protectedIds: number[];
  /** Hourly accepted counts of the protected projects since the window start. */
  hours: SpikeHour[];
};

export class SpikeStore {
  readonly #db: D1Database;

  constructor(db: D1Database) {
    this.#db = db;
  }

  /** Hours in `[since, before)`, so the current, incomplete hour is left out. */
  async read(since: number, before: number): Promise<SpikeInput> {
    const db = this.#db;

    const [projects, hours] = await Promise.all([
      db
        .prepare(`SELECT id, spike_protection AS protected FROM projects`)
        .all<{ id: number; protected: number }>(),
      db
        .prepare(
          `SELECT ps.project_id AS projectId, ps.bucket, ps.received
           FROM project_stats ps JOIN projects p ON p.id = ps.project_id
           WHERE p.spike_protection = 1 AND ps.bucket >= ?1 AND ps.bucket < ?2`,
        )
        .bind(since, before)
        .all<SpikeHour>(),
    ]);

    return {
      projectCount: projects.results.length,
      protectedIds: projects.results.flatMap((row) => (row.protected === 1 ? [row.id] : [])),
      hours: hours.results,
    };
  }

  /** One statement for every project, whatever their number. */
  async write(limits: SpikeLimit[]): Promise<void> {
    await this.#db
      .prepare(
        `UPDATE projects SET spike_limit_per_hour = j.value->>'limit'
         FROM json_each(?1) AS j
         WHERE projects.id = j.value->>'p'`,
      )
      .bind(JSON.stringify(limits))
      .run();
  }
}
