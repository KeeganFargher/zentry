import { METRIC_CAPTURE_CACHE_MS } from "@/shared/monitors";
import type { QueueMessage } from "@/shared/types";

/**
 * The projects that have metric monitors, cached per isolate. Without the
 * cache every SDK event for every project cost a D1 query before it was
 * queued, so an overloaded database turned error ingest into 503s. Coverage
 * for a new monitor starts METRIC_CAPTURE_CACHE_MS late to allow for an
 * isolate whose cached list does not have the project yet.
 */
export class MetricCapture {
  readonly #db: D1Database;
  #projects: Set<number> = new Set();
  #expiresAt = 0;

  constructor(db: D1Database) {
    this.#db = db;
  }

  async captures(projectId: number, now: number): Promise<boolean> {
    if (now >= this.#expiresAt) {
      const { results } = await this.#db
        .prepare(`SELECT project_id AS projectId FROM metric_capture`)
        .all<{ projectId: number }>();

      this.#projects = new Set(results.map((row) => row.projectId));
      this.#expiresAt = now + METRIC_CAPTURE_CACHE_MS;
    }

    return this.#projects.has(projectId);
  }
}

/**
 * Announce expected input before publishing it, for projects with metric
 * monitors only. An ambiguous publish leaves the window unknown until the same
 * event is delivered. The announcement is timestamped in D1 so slow spills
 * cannot backdate a closed window.
 */
export async function enqueueMetricInput(
  input: { db: D1Database; queue: Queue<QueueMessage>; capture: MetricCapture; now: number },
  message: QueueMessage,
): Promise<void> {
  if (await input.capture.captures(message.project_id, input.now)) {
    await input.db
      .prepare(`
      INSERT INTO metric_pending(project_id, event_id, received_at)
      SELECT ?1, ?2, CAST(unixepoch('subsec') * 1000 AS INTEGER)
      WHERE NOT EXISTS (SELECT 1 FROM metric_receipts WHERE project_id = ?1 AND event_id = ?2)
      ON CONFLICT DO NOTHING`)
      .bind(message.project_id, message.event_id)
      .run();
  }

  await input.queue.send(message);
}
