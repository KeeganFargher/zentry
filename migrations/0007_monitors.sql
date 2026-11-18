CREATE TABLE monitors (
  id          TEXT PRIMARY KEY NOT NULL,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('metric', 'cron', 'uptime')),
  config      TEXT NOT NULL CHECK (json_valid(config)),
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  health      TEXT NOT NULL DEFAULT 'awaiting_data'
              CHECK (health IN ('awaiting_data', 'healthy', 'degraded', 'failing', 'unknown')),
  next_cron_at INTEGER,
  generation INTEGER NOT NULL DEFAULT 1,
  probe_started INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_expires INTEGER,
  slot INTEGER,
  failures INTEGER NOT NULL DEFAULT 0,
  successes INTEGER NOT NULL DEFAULT 0,
  last_result TEXT CHECK (json_valid(last_result)),
  evaluated_at INTEGER,
  notify      INTEGER NOT NULL DEFAULT 0 CHECK (notify IN (0,1)),
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);
CREATE INDEX monitors_by_project ON monitors(project_id, id);

CREATE TABLE metric_receipts (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  minute INTEGER NOT NULL,
  environment TEXT NOT NULL,
  PRIMARY KEY (project_id, event_id)
) WITHOUT ROWID;
CREATE INDEX metric_receipts_by_minute ON metric_receipts(minute);

CREATE TABLE metric_minutes (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  minute INTEGER NOT NULL,
  environment TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (project_id, minute, environment)
) WITHOUT ROWID;

-- The receipt is independent of full-event storage. A redelivery with the same
-- event ID never increments the rollup, even if the event body was sampled out.
CREATE TRIGGER metric_receipt_rollup AFTER INSERT ON metric_receipts
BEGIN
  INSERT INTO metric_minutes (project_id, minute, environment, count)
  VALUES (NEW.project_id, NEW.minute, NEW.environment, 1)
  ON CONFLICT(project_id, minute, environment) DO UPDATE SET count = count + 1;
END;
CREATE UNIQUE INDEX cron_monitor_scope ON monitors (
  project_id, json_extract(config, '$.slug'), json_extract(config, '$.environment')
) WHERE type = 'cron' AND status != 'archived';

CREATE TABLE cron_checkins (
  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  check_in_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('in_progress', 'ok', 'error')),
  received_at INTEGER NOT NULL,
  duration_ms INTEGER,
  timed_out INTEGER NOT NULL DEFAULT 0,
  generation INTEGER NOT NULL,
  PRIMARY KEY (monitor_id, check_in_id, status)
) WITHOUT ROWID;

-- Only the first terminal result for a run advances health.
CREATE UNIQUE INDEX cron_checkin_terminal ON cron_checkins(monitor_id, check_in_id)
  WHERE status IN ('ok', 'error');

CREATE TRIGGER cron_checkin_health AFTER INSERT ON cron_checkins
WHEN NEW.status IN ('ok', 'error') AND NOT EXISTS (
  SELECT 1 FROM cron_checkins WHERE monitor_id = NEW.monitor_id AND check_in_id = NEW.check_in_id AND timed_out = 1
)
BEGIN
  UPDATE monitors
  SET health = CASE
        WHEN NEW.status = 'ok' AND successes + 1 >= json_extract(config, '$.recoveryThreshold') THEN 'healthy'
        WHEN NEW.status = 'error' AND failures + 1 >= json_extract(config, '$.failureThreshold') THEN 'failing'
        WHEN health = 'failing' THEN 'failing'
        ELSE 'degraded'
      END,
      failures = CASE NEW.status WHEN 'error' THEN failures + 1 ELSE 0 END,
      successes = CASE NEW.status WHEN 'ok' THEN successes + 1 ELSE 0 END,
      evaluated_at = NEW.received_at,
      last_result = json_object('outcome',NEW.status,'durationMs',NEW.duration_ms)
  WHERE id = NEW.monitor_id AND generation = NEW.generation
    AND (evaluated_at IS NULL OR evaluated_at <= COALESCE(
      (SELECT received_at FROM cron_checkins WHERE monitor_id = NEW.monitor_id
        AND check_in_id = NEW.check_in_id AND status = 'in_progress'),
      NEW.received_at));
END;

ALTER TABLE groups ADD COLUMN monitor_id TEXT REFERENCES monitors(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX groups_by_monitor ON groups(monitor_id) WHERE monitor_id IS NOT NULL;

CREATE TABLE monitor_observations (
  id INTEGER PRIMARY KEY,
  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  evaluated_at INTEGER NOT NULL,
  health TEXT NOT NULL,
  evidence TEXT NOT NULL CHECK (json_valid(evidence))
);
CREATE INDEX monitor_observations_recent ON monitor_observations(monitor_id, evaluated_at DESC, id DESC);

CREATE TRIGGER monitor_history AFTER UPDATE OF evaluated_at ON monitors
WHEN NEW.evaluated_at IS NOT NULL AND NEW.evaluated_at IS NOT OLD.evaluated_at
BEGIN
  INSERT INTO monitor_observations (monitor_id, evaluated_at, health, evidence)
  VALUES (NEW.id, NEW.evaluated_at, NEW.health, COALESCE(NEW.last_result, '{}'));
END;

-- The issue, activity and notification intent change in the same transaction as health.
CREATE TRIGGER monitor_issue_open AFTER UPDATE OF health ON monitors
WHEN NEW.health = 'failing' AND NEW.evaluated_at IS NOT NULL AND NEW.status = 'active'
  AND (NEW.evaluated_at IS NOT OLD.evaluated_at OR NEW.last_result IS NOT OLD.last_result)
BEGIN
  UPDATE projects SET next_short_id = next_short_id + 1
  WHERE id = NEW.project_id AND NOT EXISTS (SELECT 1 FROM groups WHERE monitor_id = NEW.id);

  INSERT INTO notify_outbox (kind, organization_id, project_id, group_id, created_at)
  SELECT 'regression', p.organization_id, g.project_id, g.id, NEW.evaluated_at
  FROM groups g JOIN projects p ON p.id = g.project_id
  WHERE g.monitor_id = NEW.id AND g.status = 'resolved' AND NEW.notify = 1;

  INSERT INTO activity (group_id, project_id, type, data, created_at)
  SELECT id, project_id, 'regressed', '{}', NEW.evaluated_at
  FROM groups WHERE monitor_id = NEW.id AND status = 'resolved';

  UPDATE groups SET status = 'unresolved',
    substatus = CASE status WHEN 'resolved' THEN 'regressed' ELSE substatus END,
    resolved_at = NULL, resolved_by = NULL, title = NEW.name,
    last_seen = NEW.evaluated_at, times_seen = times_seen + 1
  WHERE monitor_id = NEW.id AND status IN ('unresolved', 'resolved');

  INSERT INTO groups (project_id, short_id, primary_hash, title, level, metadata,
    status, times_seen, first_seen, last_seen, created_at, monitor_id)
  SELECT NEW.project_id, next_short_id, 'monitor:' || NEW.id, NEW.name, 'error',
    json_object('type', NEW.type, 'value', NULL, 'function', NULL, 'filename', NULL, 'logger', NULL),
    'unresolved', 1, NEW.evaluated_at, NEW.evaluated_at, NEW.evaluated_at, NEW.id
  FROM projects WHERE id = NEW.project_id AND NOT EXISTS (SELECT 1 FROM groups WHERE monitor_id = NEW.id);

  INSERT INTO notify_outbox (kind, organization_id, project_id, group_id, created_at)
  SELECT 'new_issue', p.organization_id, g.project_id, g.id, NEW.evaluated_at
  FROM groups g JOIN projects p ON p.id = g.project_id
  WHERE g.monitor_id = NEW.id AND g.times_seen = 1 AND NEW.notify = 1;
END;

CREATE TRIGGER monitor_issue_resolve AFTER UPDATE OF health ON monitors
WHEN NEW.health = 'healthy' AND NEW.evaluated_at IS NOT NULL
  AND (NEW.evaluated_at IS NOT OLD.evaluated_at OR NEW.last_result IS NOT OLD.last_result)
BEGIN
  INSERT INTO activity (group_id, project_id, type, data, created_at)
  SELECT id, project_id, 'resolved', '{}', NEW.evaluated_at
  FROM groups WHERE monitor_id = NEW.id AND status = 'unresolved';

  INSERT INTO notify_outbox (kind, organization_id, project_id, group_id, data, created_at)
  SELECT 'status', p.organization_id, g.project_id, g.id, json_object('status','resolved'), NEW.evaluated_at
  FROM groups g JOIN projects p ON p.id = g.project_id
  WHERE g.monitor_id = NEW.id AND g.status = 'unresolved' AND NEW.notify = 1;

  UPDATE groups SET status = 'resolved', substatus = NULL, resolved_at = NEW.evaluated_at
  WHERE monitor_id = NEW.id AND status = 'unresolved';
END;

CREATE INDEX cron_pending_deadlines ON cron_checkins(received_at, monitor_id)
WHERE status = 'in_progress' AND timed_out = 0;
CREATE INDEX cron_due ON monitors(next_cron_at) WHERE type = 'cron' AND status = 'active';

CREATE TRIGGER cron_runtime_timeout AFTER UPDATE OF timed_out ON cron_checkins
WHEN NEW.timed_out = 1
BEGIN
  UPDATE monitors SET health = CASE
      WHEN failures + 1 >= json_extract(config, '$.failureThreshold') OR health = 'failing' THEN 'failing'
      ELSE 'degraded' END,
    failures = failures + 1, successes = 0,
    evaluated_at = NEW.received_at + json_extract(config, '$.maxRuntimeMinutes') * 60000,
    last_result = json_object('outcome','timed_out')
  WHERE id = NEW.monitor_id AND generation = NEW.generation
    AND (evaluated_at IS NULL OR evaluated_at <= COALESCE(
      (SELECT received_at FROM cron_checkins WHERE monitor_id = NEW.monitor_id
        AND check_in_id = NEW.check_in_id AND status = 'in_progress'),
      NEW.received_at));
END;

CREATE INDEX metric_minutes_retention ON metric_minutes(minute);
CREATE INDEX monitor_observations_retention ON monitor_observations(evaluated_at);
CREATE INDEX cron_checkins_retention ON cron_checkins(received_at);

CREATE INDEX monitors_metrics_due ON monitors(evaluated_at, id)
WHERE type = 'metric' AND status = 'active';
CREATE INDEX monitors_uptime_due ON monitors(evaluated_at, id)
WHERE type = 'uptime' AND status = 'active';

-- Cancel outstanding notifications when detection is paused or delivery is disabled.
CREATE TRIGGER monitor_cancel_delivery AFTER UPDATE OF status, notify ON monitors
WHEN (OLD.status = 'active' AND NEW.status != 'active') OR (OLD.notify = 1 AND NEW.notify = 0)
BEGIN
  DELETE FROM notify_outbox WHERE group_id IN (SELECT id FROM groups WHERE monitor_id = NEW.id);
  DELETE FROM digest_pending WHERE group_id IN (SELECT id FROM groups WHERE monitor_id = NEW.id);
END;
