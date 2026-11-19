type Window = { start: string; end: string };

function countForWindow(project: string, config: string, { start, end }: Window): string {
  return `(SELECT COALESCE(SUM(count), 0) FROM metric_level_minutes p
    WHERE p.project_id = ${project} AND p.minute >= ${start} AND p.minute < ${end}
      AND (json_extract(${config}, '$.environment') IS NULL OR p.environment = json_extract(${config}, '$.environment'))
      AND (json_extract(${config}, '$.level') IS NULL OR p.level = json_extract(${config}, '$.level')))`;
}

function windowCovered(project: string, since: string, { start, end }: Window): string {
  return `(${since} <= ${start} AND NOT EXISTS (SELECT 1 FROM metric_pending input
    WHERE input.project_id = ${project} AND input.received_at >= ${start} AND input.received_at < ${end}))`;
}

function thresholdCrossed(field: string): string {
  const limit = `json_extract(config, '$.${field}')`;

  return `CASE json_extract(config, '$.comparator')
    WHEN 'gt' THEN count > ${limit} WHEN 'lt' THEN count < ${limit}
    WHEN 'lte' THEN count <= ${limit} ELSE count >= ${limit} END`;
}

const recoveryCrossed = `CASE json_extract(config, '$.comparator')
  WHEN 'lt' THEN count >= COALESCE(json_extract(config, '$.recoveryThreshold'),
    json_extract(config, '$.warningThreshold'), json_extract(config, '$.threshold'))
  WHEN 'lte' THEN count >= COALESCE(json_extract(config, '$.recoveryThreshold'),
    COALESCE(json_extract(config, '$.warningThreshold'), json_extract(config, '$.threshold')) + 1)
  WHEN 'gt' THEN count <= COALESCE(json_extract(config, '$.recoveryThreshold'),
    json_extract(config, '$.warningThreshold'), json_extract(config, '$.threshold'))
  ELSE count <= COALESCE(json_extract(config, '$.recoveryThreshold'),
    COALESCE(json_extract(config, '$.warningThreshold'), json_extract(config, '$.threshold')) - 1)
END`;

export const previewMetricQuery = `WITH RECURSIVE points(time) AS (
        VALUES (?1) UNION ALL SELECT time - 60000 FROM points WHERE time > ?1 - 19 * 60000
      )
      SELECT time, ${countForWindow("?2", "?3", { start: "time - ?4", end: "time" })} AS count,
        COALESCE(${windowCovered("?2", "(SELECT started_at FROM metric_capture WHERE project_id = ?2)", { start: "time - ?4", end: "time" })}, 0) AS covered
      FROM points ORDER BY time`;

export const evaluateMetricQuery = `WITH due AS MATERIALIZED (
          SELECT id, project_id, config, severity, capture.started_at,
            ?1 - json_extract(config, '$.windowSeconds') * 1000 AS windowStart
          FROM monitors JOIN metric_capture capture USING(project_id)
          WHERE type = 'metric' AND status = 'active'
            AND created_at < ?1 AND evaluation_after < ?1 AND (evaluated_at IS NULL OR evaluated_at < ?1)
          ORDER BY evaluated_at, id LIMIT 100
        ), windows AS MATERIALIZED (
          SELECT due.*, ${countForWindow("due.project_id", "due.config", { start: "windowStart", end: "?1" })} AS count,
            ${windowCovered("due.project_id", "started_at", { start: "windowStart", end: "?1" })} AS covered
          FROM due
        ), decisions AS (
          SELECT windows.*, CASE
            WHEN NOT covered THEN severity
            WHEN ${thresholdCrossed("threshold")} THEN 'high'
            WHEN ${thresholdCrossed("warningThreshold")} THEN 'medium'
            WHEN ${recoveryCrossed} THEN NULL
            ELSE severity
          END AS nextSeverity FROM windows
        )
        UPDATE monitors SET evaluated_at = ?1, severity = nextSeverity,
          last_result = json_object('count', decisions.count, 'windowEnd', ?1,
            'windowStart', decisions.windowStart, 'coverage', decisions.covered, 'severity', nextSeverity),
          health = CASE
            WHEN decisions.started_at > decisions.windowStart THEN 'awaiting_data'
            WHEN NOT decisions.covered THEN 'unknown'
            WHEN nextSeverity IS NOT NULL THEN 'failing'
            ELSE 'healthy'
          END
        FROM decisions WHERE monitors.id = decisions.id
        `;
