// Statements for spike-protection thresholds (DESIGN.md §6).

export type SpikeHour = { projectId: number; bucket: number; received: number };

export type SpikeLimit = { p: number; limit: number };

/** A protected project, with what its floor depends on. */
export type SpikeProject = {
  projectId: number;
  /** The organization's monthly cap. */
  maxEventsPerMonth: number;
  /** All of the organization's projects, protected or not. */
  projectCount: number;
};

export type SpikeInput = {
  projects: SpikeProject[];
  /** Hourly accepted counts of the protected projects. */
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
        .prepare(
          `SELECT p.id AS projectId, o.max_events_per_month AS maxEventsPerMonth,
                  (SELECT count(*) FROM projects q WHERE q.organization_id = p.organization_id)
                    AS projectCount
           FROM projects p JOIN organizations o ON o.id = p.organization_id
           WHERE p.spike_protection = 1`,
        )
        .all<SpikeProject>(),
      db
        .prepare(
          `SELECT ps.project_id AS projectId, ps.bucket, ps.received
           FROM project_stats ps JOIN projects p ON p.id = ps.project_id
           WHERE p.spike_protection = 1 AND ps.bucket >= ?1 AND ps.bucket < ?2`,
        )
        .bind(since, before)
        .all<SpikeHour>(),
    ]);

    return { projects: projects.results, hours: hours.results };
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
