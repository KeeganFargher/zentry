import type { QueueMessage } from "@/shared/types";

/** Announce expected input before publishing it. An ambiguous publish leaves
 * the window unknown until the same event is successfully delivered. Timestamp
 * the announcement in D1 so slow spills cannot backdate a closed window. */
export async function enqueueMetricInput(
  db: D1Database,
  queue: Queue<QueueMessage>,
  message: QueueMessage,
): Promise<void> {
  await db
    .prepare(`
    INSERT INTO metric_pending(project_id, event_id, received_at)
    SELECT ?1, ?2, CAST(unixepoch('subsec') * 1000 AS INTEGER) FROM metric_capture WHERE project_id = ?1
      AND NOT EXISTS (SELECT 1 FROM metric_receipts WHERE project_id = ?1 AND event_id = ?2)
    ON CONFLICT DO NOTHING`)
    .bind(message.project_id, message.event_id)
    .run();

  await queue.send(message);
}
