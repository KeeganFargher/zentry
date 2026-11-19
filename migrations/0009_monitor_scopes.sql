DROP TRIGGER cron_checkin_health;
DROP TRIGGER cron_runtime_timeout;
DROP INDEX cron_monitor_scope;

UPDATE monitors SET config = json_remove(
  json_set(config, '$.environments', json_array(json_extract(config, '$.environment'))),
  '$.environment')
WHERE type = 'cron';

CREATE UNIQUE INDEX cron_monitor_slug ON monitors(project_id, json_extract(config, '$.slug'))
  WHERE type = 'cron' AND status != 'archived';

CREATE TABLE cron_scopes (
  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  environment TEXT NOT NULL,
  generation INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  write_token TEXT,
  next_at INTEGER,
  applied_at INTEGER,
  health TEXT NOT NULL DEFAULT 'awaiting_data',
  failures INTEGER NOT NULL DEFAULT 0,
  successes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(monitor_id, environment)
) WITHOUT ROWID;
CREATE INDEX cron_scope_due ON cron_scopes(next_at) WHERE next_at IS NOT NULL;

INSERT INTO cron_scopes (monitor_id, environment, generation, next_at, health, failures, successes)
SELECT m.id, e.value, m.generation, m.next_cron_at, m.health, m.failures, m.successes
FROM monitors m, json_each(m.config, '$.environments') e
WHERE m.type = 'cron';

CREATE TRIGGER cron_scope_insert AFTER INSERT ON monitors WHEN NEW.type = 'cron'
BEGIN
  INSERT INTO cron_scopes(monitor_id, environment, generation)
  SELECT NEW.id, value, NEW.generation FROM json_each(NEW.config, '$.environments');
END;

CREATE TRIGGER cron_scope_reset AFTER UPDATE OF generation ON monitors
WHEN NEW.type = 'cron' AND NEW.generation != OLD.generation
BEGIN
  DELETE FROM cron_scopes WHERE monitor_id = NEW.id;
  INSERT INTO cron_scopes(monitor_id, environment, generation)
  SELECT NEW.id, value, NEW.generation FROM json_each(NEW.config, '$.environments');
END;

CREATE TABLE cron_receipts (
  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  environment TEXT NOT NULL,
  run_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('start','finish')),
  received_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  duration_ms INTEGER,
  PRIMARY KEY(monitor_id, environment, run_id, phase)
) WITHOUT ROWID;
CREATE INDEX cron_receipts_retention ON cron_receipts(received_at);
INSERT INTO cron_receipts
SELECT c.monitor_id, json_extract(m.config,'$.environments[0]'), c.check_in_id,
  CASE WHEN c.status = 'in_progress' THEN 'start' ELSE 'finish' END,
  c.received_at, c.status, c.duration_ms
FROM cron_checkins c JOIN monitors m ON m.id = c.monitor_id;
DROP TABLE cron_checkins;

CREATE TABLE cron_runs (
  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  environment TEXT NOT NULL,
  generation INTEGER NOT NULL,
  slot INTEGER NOT NULL,
  run_id TEXT,
  started_at INTEGER,
  received_at INTEGER NOT NULL,
  deadline INTEGER,
  completed_at INTEGER,
  duration_ms INTEGER,
  outcome TEXT CHECK(outcome IN ('ok','error','missed','timed_out','unknown')),
  PRIMARY KEY(monitor_id, environment, generation, slot),
  UNIQUE(monitor_id, environment, run_id)
) WITHOUT ROWID;
CREATE INDEX cron_run_deadline ON cron_runs(deadline) WHERE outcome IS NULL;
CREATE INDEX cron_run_retention ON cron_runs(received_at);

DROP INDEX groups_by_monitor;
ALTER TABLE groups ADD COLUMN monitor_scope TEXT NOT NULL DEFAULT '';
UPDATE groups SET monitor_scope = (
  SELECT json_extract(m.config,'$.environments[0]') FROM monitors m WHERE m.id = groups.monitor_id
) WHERE monitor_id IN (SELECT id FROM monitors WHERE type = 'cron');
UPDATE groups SET monitor_scope = COALESCE((
  SELECT json_extract(m.config,'$.environment') FROM monitors m WHERE m.id = groups.monitor_id
),'') WHERE monitor_id IN (SELECT id FROM monitors WHERE type IN ('metric','uptime'));
CREATE UNIQUE INDEX groups_by_monitor ON groups(monitor_id, monitor_scope) WHERE monitor_id IS NOT NULL;

ALTER TABLE monitor_observations ADD COLUMN scope TEXT NOT NULL DEFAULT '';
ALTER TABLE monitor_observations ADD COLUMN severity TEXT;
ALTER TABLE monitor_observations ADD COLUMN generation INTEGER NOT NULL DEFAULT 1;
ALTER TABLE monitor_observations ADD COLUMN slot INTEGER;
CREATE UNIQUE INDEX monitor_observation_slot ON monitor_observations(monitor_id, scope, generation, slot)
WHERE slot IS NOT NULL;

DROP TRIGGER monitor_history;
CREATE TRIGGER monitor_history AFTER UPDATE OF evaluated_at ON monitors
WHEN NEW.type != 'cron' AND NEW.evaluated_at IS NOT NULL AND NEW.evaluated_at IS NOT OLD.evaluated_at
BEGIN
  INSERT INTO monitor_observations(monitor_id, evaluated_at, health, evidence, severity, generation, slot, scope)
  VALUES(NEW.id, NEW.evaluated_at, NEW.health, COALESCE(NEW.last_result,'{}'), NEW.severity, NEW.generation, NEW.evaluated_at, COALESCE(json_extract(NEW.config,'$.environment'),''));
END;

CREATE TABLE monitor_periods (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  opened_at INTEGER NOT NULL,
  closed_at INTEGER,
  disposition TEXT,
  evidence TEXT NOT NULL
);
CREATE UNIQUE INDEX monitor_period_open ON monitor_periods(group_id) WHERE closed_at IS NULL;

DROP TRIGGER monitor_issue_open;
DROP TRIGGER monitor_issue_resolve;

CREATE TRIGGER monitor_observation_issue AFTER INSERT ON monitor_observations
WHEN NEW.health IN ('healthy','failing')
BEGIN
  UPDATE projects SET next_short_id = next_short_id + 1
  WHERE NEW.health = 'failing' AND id = (SELECT project_id FROM monitors WHERE id = NEW.monitor_id)
    AND NOT EXISTS (SELECT 1 FROM groups WHERE monitor_id = NEW.monitor_id AND monitor_scope = NEW.scope);

  INSERT INTO groups(project_id, short_id, primary_hash, title, level, metadata,
    status, times_seen, first_seen, last_seen, created_at, monitor_id, monitor_scope)
  SELECT p.id, p.next_short_id, 'monitor:' || m.id || ':' || NEW.scope, m.name,
    CASE NEW.severity WHEN 'medium' THEN 'warning' ELSE 'error' END,
    json_object('type',m.type,'value',NULL,'function',NULL,'filename',NULL,'logger',NULL),
    'unresolved', 0, NEW.evaluated_at, NEW.evaluated_at, NEW.evaluated_at, m.id, NEW.scope
  FROM monitors m JOIN projects p ON p.id = m.project_id
  WHERE m.id = NEW.monitor_id AND NEW.health = 'failing'
    AND NOT EXISTS (SELECT 1 FROM groups WHERE monitor_id = m.id AND monitor_scope = NEW.scope);

  INSERT INTO activity(group_id, project_id, type, data, created_at)
  SELECT id, project_id, CASE NEW.health WHEN 'healthy' THEN 'resolved' ELSE 'regressed' END,
    NEW.evidence, NEW.evaluated_at
  FROM groups WHERE monitor_id = NEW.monitor_id AND monitor_scope = NEW.scope AND (
    (NEW.health = 'healthy' AND status = 'unresolved') OR (NEW.health = 'failing' AND status = 'resolved')
  );

  INSERT INTO monitor_periods(group_id, opened_at, evidence)
  SELECT id, NEW.evaluated_at, NEW.evidence FROM groups
  WHERE monitor_id = NEW.monitor_id AND monitor_scope = NEW.scope AND NEW.health = 'failing'
  ON CONFLICT DO NOTHING;

  UPDATE monitor_periods SET closed_at = NEW.evaluated_at, disposition = 'recovered'
  WHERE closed_at IS NULL AND NEW.health = 'healthy' AND group_id IN (
    SELECT id FROM groups WHERE monitor_id = NEW.monitor_id AND monitor_scope = NEW.scope
  );

  UPDATE groups SET
    status = CASE NEW.health WHEN 'healthy' THEN 'resolved' ELSE 'unresolved' END,
    substatus = CASE WHEN NEW.health = 'healthy' THEN NULL WHEN status = 'resolved' THEN 'regressed' ELSE substatus END,
    level = CASE WHEN NEW.health = 'healthy' THEN level WHEN NEW.severity = 'medium' THEN 'warning' ELSE 'error' END,
    resolved_at = CASE NEW.health WHEN 'healthy' THEN NEW.evaluated_at ELSE NULL END,
    resolved_by = NULL,
    last_seen = CASE NEW.health WHEN 'failing' THEN NEW.evaluated_at ELSE last_seen END,
    times_seen = times_seen + (NEW.health = 'failing')
  WHERE monitor_id = NEW.monitor_id AND monitor_scope = NEW.scope
    AND (NEW.health = 'failing' OR status = 'unresolved');
END;

CREATE TRIGGER monitor_invalidate_period AFTER UPDATE OF generation ON monitors
WHEN NEW.generation != OLD.generation AND (NEW.config != OLD.config OR NEW.status = 'archived')
BEGIN
  UPDATE monitor_periods SET closed_at = CAST(unixepoch('subsec') * 1000 AS INTEGER), disposition = 'configuration_changed'
  WHERE closed_at IS NULL AND group_id IN (SELECT id FROM groups WHERE monitor_id = NEW.id);

  UPDATE groups SET status = 'resolved', substatus = NULL, resolved_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
  WHERE monitor_id = NEW.id AND status = 'unresolved';
END;

-- Apply finalized runs in slot order within an environment. Later results
-- wait while an older run remains open, regardless of receipt order.
CREATE TABLE cron_applied (
  monitor_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  generation INTEGER NOT NULL,
  slot INTEGER NOT NULL,
  decided_at INTEGER NOT NULL,
  PRIMARY KEY(monitor_id, environment, generation, slot),
  FOREIGN KEY(monitor_id, environment, generation, slot)
    REFERENCES cron_runs(monitor_id, environment, generation, slot) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE TRIGGER cron_scope_apply AFTER INSERT ON cron_applied
BEGIN
  UPDATE cron_scopes SET
    revision = revision + 1,
    applied_at = NEW.slot,
    failures = CASE WHEN run.outcome IN ('error','missed','timed_out') THEN cron_scopes.failures + 1 ELSE 0 END,
    successes = CASE run.outcome WHEN 'ok' THEN cron_scopes.successes + 1 ELSE 0 END,
    health = CASE
      WHEN run.outcome = 'unknown' THEN 'unknown'
      WHEN run.outcome = 'ok' AND cron_scopes.successes + 1 >= json_extract(m.config,'$.recoveryThreshold') THEN 'healthy'
      WHEN run.outcome IN ('error','missed','timed_out') AND cron_scopes.failures + 1 >= json_extract(m.config,'$.failureThreshold') THEN 'failing'
      WHEN cron_scopes.health = 'failing' THEN 'failing'
      ELSE 'degraded' END
  FROM cron_runs run JOIN monitors m ON m.id = run.monitor_id
  WHERE cron_scopes.monitor_id = NEW.monitor_id AND cron_scopes.environment = NEW.environment
    AND cron_scopes.generation = NEW.generation AND run.environment = NEW.environment
    AND run.generation = NEW.generation AND run.slot = NEW.slot AND run.monitor_id = NEW.monitor_id;

  INSERT INTO monitor_observations(monitor_id, evaluated_at, health, evidence, scope, severity, generation, slot)
  SELECT run.monitor_id, NEW.decided_at, s.health,
    json_object('outcome',run.outcome,'expectedAt',run.slot,'receivedAt',run.received_at,
      'startedAt',run.started_at,'completedAt',run.completed_at,'runId',run.run_id,'durationMs',run.duration_ms),
    run.environment, CASE s.health WHEN 'failing' THEN 'high' ELSE NULL END, run.generation, run.slot
  FROM cron_runs run JOIN cron_scopes s ON s.monitor_id = run.monitor_id AND s.environment = run.environment
  WHERE run.monitor_id = NEW.monitor_id AND run.environment = NEW.environment AND run.generation = NEW.generation AND run.slot = NEW.slot;

  UPDATE monitors SET evaluated_at = MAX(COALESCE(evaluated_at,0), NEW.decided_at),
    health = (SELECT health FROM cron_scopes WHERE monitor_id = NEW.monitor_id ORDER BY CASE health
      WHEN 'failing' THEN 1 WHEN 'degraded' THEN 2 WHEN 'unknown' THEN 3 WHEN 'awaiting_data' THEN 4 ELSE 5 END LIMIT 1)
  WHERE id = NEW.monitor_id;
END;
