-- Metric, Cron and Uptime monitors (docs/sentry-monitoring-workers-plan.md).
--
-- One migration for the whole feature: it has never been applied to a deployed
-- database, so there is no earlier monitor schema to migrate from.
--
-- Cron state transitions are decided in TypeScript (src/core/cron-checkins.ts)
-- and written with a compare-and-swap on cron_environments. The issue, incident
-- period and alert delivery chain below is shared by all three types and runs
-- as triggers on monitor_observations; see the notes on each.

CREATE TABLE monitors (
  id               TEXT PRIMARY KEY NOT NULL,
  project_id       INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  type             TEXT NOT NULL CHECK (type IN ('metric', 'cron', 'uptime')),
  config           TEXT NOT NULL CHECK (json_valid(config)),
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  health           TEXT NOT NULL DEFAULT 'awaiting_data'
                   CHECK (health IN ('awaiting_data', 'healthy', 'degraded', 'failing', 'unknown')),
  severity         TEXT CHECK (severity IN ('medium', 'high')),
  -- Bumped when signal semantics change; outputs of an older generation are ignored.
  generation       INTEGER NOT NULL DEFAULT 1,
  -- Metric and uptime evaluation state. Cron keeps its state per environment.
  evaluated_at     INTEGER,
  evaluation_after INTEGER NOT NULL DEFAULT 0,
  last_result      TEXT CHECK (json_valid(last_result)),
  failures         INTEGER NOT NULL DEFAULT 0,
  successes        INTEGER NOT NULL DEFAULT 0,
  -- Uptime probe lease for the current slot.
  slot             INTEGER,
  lease_token      TEXT,
  lease_expires    INTEGER,
  probe_started    INTEGER NOT NULL DEFAULT 0,
  -- When the scheduler last claimed this uptime monitor; the oldest claim goes first.
  claimed_at       INTEGER,
  notify           INTEGER NOT NULL DEFAULT 0 CHECK (notify IN (0, 1)),
  -- Created by an SDK check-in's monitor_config rather than in the UI.
  provisioned      INTEGER NOT NULL DEFAULT 0 CHECK (provisioned IN (0, 1)),
  owner_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  muted_until      INTEGER,
  alert_rule_ids   TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(alert_rule_ids)),
  version          INTEGER NOT NULL DEFAULT 1,
  -- Stamped by each settings or status change, so statements batched with it
  -- apply only when that change won its optimistic version check.
  write_token      TEXT,
  changed_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  changed_at       INTEGER,
  request_key      TEXT,
  created_at       INTEGER NOT NULL
);
CREATE INDEX monitors_by_project ON monitors(project_id, id);
CREATE UNIQUE INDEX monitor_request_key ON monitors(project_id, request_key) WHERE request_key IS NOT NULL;
CREATE INDEX monitors_metrics_due ON monitors(evaluated_at, id) WHERE type = 'metric' AND status = 'active';
CREATE INDEX monitors_uptime_due ON monitors(claimed_at, id) WHERE type = 'uptime' AND status = 'active';
-- A slug is how SDK check-ins find their monitor. Lookups repeat this exact
-- expression and predicate so that SQLite can use the partial index.
CREATE UNIQUE INDEX cron_monitor_slug ON monitors(project_id, json_extract(config, '$.slug'))
  WHERE type = 'cron' AND status != 'archived';

-- ── Metric input ────────────────────────────────────────────────────

-- The receipt is independent of full-event storage. A redelivery with the same
-- event ID never increments the rollup, even if the event body was sampled out.
CREATE TABLE metric_receipts (
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_id    TEXT NOT NULL,
  minute      INTEGER NOT NULL,
  environment TEXT NOT NULL,
  level       TEXT NOT NULL,
  PRIMARY KEY (project_id, event_id)
) WITHOUT ROWID;
CREATE INDEX metric_receipts_by_minute ON metric_receipts(minute);

CREATE TABLE metric_level_minutes (
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  minute      INTEGER NOT NULL,
  environment TEXT NOT NULL,
  level       TEXT NOT NULL,
  count       INTEGER NOT NULL,
  PRIMARY KEY (project_id, minute, environment, level)
) WITHOUT ROWID;
CREATE INDEX metric_level_retention ON metric_level_minutes(minute);

CREATE TRIGGER metric_receipt_rollup AFTER INSERT ON metric_receipts
BEGIN
  INSERT INTO metric_level_minutes (project_id, minute, environment, level, count)
  VALUES (NEW.project_id, NEW.minute, NEW.environment, NEW.level, 1)
  ON CONFLICT(project_id, minute, environment, level) DO UPDATE SET count = count + 1;
END;

-- A minute can only support recovery or a below-threshold alert after every
-- accepted input for that minute has left the event pipeline.
CREATE TABLE metric_pending (
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_id    TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, event_id)
) WITHOUT ROWID;
CREATE INDEX metric_pending_window ON metric_pending(project_id, received_at);
CREATE INDEX metric_pending_retention ON metric_pending(received_at);

-- Projects whose events are counted. Ingest caches this list per isolate for a
-- minute (METRIC_CAPTURE_CACHE_MS in src/shared/monitors.ts), so coverage starts
-- one minute after the first metric monitor: until every isolate has refreshed,
-- some accepted events have no pending row and a window could look complete.
CREATE TABLE metric_capture (
  project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL
);

CREATE TRIGGER metric_capture_started AFTER INSERT ON monitors
WHEN NEW.type = 'metric'
BEGIN
  INSERT OR IGNORE INTO metric_capture(project_id, started_at) VALUES (NEW.project_id, NEW.created_at + 60000);
END;

CREATE TRIGGER metric_capture_stopped AFTER UPDATE OF status ON monitors
WHEN NEW.type = 'metric' AND NEW.status = 'archived'
BEGIN
  DELETE FROM metric_capture WHERE project_id = NEW.project_id AND NOT EXISTS (
    SELECT 1 FROM monitors WHERE project_id = NEW.project_id AND type = 'metric' AND status != 'archived'
  );
END;

-- ── Cron ────────────────────────────────────────────────────────────

-- One row per monitor environment, created by its first check-in, as Sentry's
-- MonitorEnvironment. `revision` and `write_token` fence concurrent writers:
-- a writer bumps the revision it read and stamps a fresh token, and every
-- dependent statement in its batch applies only while that token is current.
CREATE TABLE cron_environments (
  monitor_id          TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  environment         TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ok', 'error')),
  -- Derived from status and failures by health() in src/core/cron-checkins.ts,
  -- stored so the monitor's overall health can be computed in SQL.
  health              TEXT NOT NULL DEFAULT 'awaiting_data'
                      CHECK (health IN ('awaiting_data', 'healthy', 'degraded', 'failing')),
  -- The schedule anchor: the start of the latest real check-in (Sentry's last_checkin).
  last_checkin        INTEGER,
  next_checkin        INTEGER,
  -- next_checkin plus the margin: when a check-in that has not arrived is missed.
  next_checkin_latest INTEGER,
  -- Start time of the newest check-in whose outcome moved the streaks, so an
  -- older run finishing late cannot override a newer decision.
  last_decided        INTEGER,
  failures            INTEGER NOT NULL DEFAULT 0,
  successes           INTEGER NOT NULL DEFAULT 0,
  revision            INTEGER NOT NULL DEFAULT 0,
  write_token         TEXT,
  created_at          INTEGER NOT NULL,
  PRIMARY KEY (monitor_id, environment)
) WITHOUT ROWID;
CREATE INDEX cron_environments_due ON cron_environments(next_checkin_latest)
  WHERE next_checkin_latest IS NOT NULL;

-- Every check-in, plus one row per missed expected check-in (Sentry's MonitorCheckIn).
CREATE TABLE cron_checkins (
  id           INTEGER PRIMARY KEY,
  monitor_id   TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  environment  TEXT NOT NULL,
  check_in_id  TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('in_progress', 'ok', 'error', 'missed', 'timeout')),
  -- Receive time of the first report for the run; the expected time for a missed row.
  date_added   INTEGER NOT NULL,
  expected_at  INTEGER,
  timeout_at   INTEGER,
  completed_at INTEGER,
  duration_ms  INTEGER,
  UNIQUE (monitor_id, check_in_id)
);
CREATE INDEX cron_checkins_recent ON cron_checkins(monitor_id, date_added DESC, id DESC);
CREATE INDEX cron_checkins_open ON cron_checkins(monitor_id, environment, date_added)
  WHERE status = 'in_progress';
CREATE INDEX cron_checkins_timeout ON cron_checkins(timeout_at) WHERE status = 'in_progress';
CREATE INDEX cron_checkins_retention ON cron_checkins(date_added);

-- Check-ins that matched no monitor that could take them. Sentry records these
-- as processing errors; here they are counted and listed by the API
-- (GET /monitors/unrecognized-check-ins), instead of being dropped silently.
CREATE TABLE cron_unrecognized (
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  slug        TEXT NOT NULL,
  environment TEXT NOT NULL,
  reason      TEXT NOT NULL
              CHECK (reason IN ('unknown_slug', 'invalid_config', 'monitor_limit', 'environment_limit', 'inactive')),
  count       INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  PRIMARY KEY (project_id, slug, environment, reason)
) WITHOUT ROWID;
CREATE INDEX cron_unrecognized_retention ON cron_unrecognized(last_seen);

-- ── History, issues and alerts (shared) ─────────────────────────────

CREATE TABLE monitor_observations (
  id           INTEGER PRIMARY KEY,
  monitor_id   TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  evaluated_at INTEGER NOT NULL,
  health       TEXT NOT NULL,
  evidence     TEXT NOT NULL CHECK (json_valid(evidence)),
  scope        TEXT NOT NULL DEFAULT '',
  severity     TEXT,
  generation   INTEGER NOT NULL,
  slot         INTEGER
);
CREATE INDEX monitor_observations_recent ON monitor_observations(monitor_id, evaluated_at DESC, id DESC);
CREATE INDEX monitor_observations_retention ON monitor_observations(evaluated_at);
CREATE UNIQUE INDEX monitor_observation_slot ON monitor_observations(monitor_id, scope, generation, slot)
  WHERE slot IS NOT NULL;

-- Metric and uptime record one observation per evaluation. Cron inserts its own.
CREATE TRIGGER monitor_history AFTER UPDATE OF evaluated_at ON monitors
WHEN NEW.type != 'cron' AND NEW.evaluated_at IS NOT NULL AND NEW.evaluated_at IS NOT OLD.evaluated_at
BEGIN
  INSERT INTO monitor_observations(monitor_id, evaluated_at, health, evidence, severity, generation, slot, scope)
  VALUES(NEW.id, NEW.evaluated_at, NEW.health, COALESCE(NEW.last_result,'{}'), NEW.severity, NEW.generation,
    NEW.evaluated_at, COALESCE(json_extract(NEW.config,'$.environment'),''));
END;

ALTER TABLE groups ADD COLUMN monitor_id TEXT REFERENCES monitors(id) ON DELETE SET NULL;
ALTER TABLE groups ADD COLUMN monitor_scope TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX groups_by_monitor ON groups(monitor_id, monitor_scope) WHERE monitor_id IS NOT NULL;

CREATE TABLE monitor_periods (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id    INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  opened_at   INTEGER NOT NULL,
  closed_at   INTEGER,
  disposition TEXT,
  evidence    TEXT NOT NULL
);
CREATE UNIQUE INDEX monitor_period_open ON monitor_periods(group_id) WHERE closed_at IS NULL;
CREATE INDEX monitor_periods_retention ON monitor_periods(closed_at) WHERE closed_at IS NOT NULL;

-- A failing observation opens or updates its scope's issue and period; a
-- healthy one resolves them. Only an observed failure counts as a sighting, so a
-- success that has not yet met the recovery streak does not bump the issue.
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
    last_seen = CASE WHEN NEW.health = 'failing' AND json_extract(NEW.evidence,'$.outcome') IS NOT 'ok'
      THEN NEW.evaluated_at ELSE last_seen END,
    times_seen = times_seen + (NEW.health = 'failing' AND json_extract(NEW.evidence,'$.outcome') IS NOT 'ok')
  WHERE monitor_id = NEW.monitor_id AND monitor_scope = NEW.scope
    AND (NEW.health = 'failing' OR status = 'unresolved');
END;

-- A metric or uptime edit that redefines failure closes the incident, since
-- the old evidence no longer answers the new question. Cron edits keep the
-- generation and their incidents, as in Sentry: a new margin does not fix a job.
CREATE TRIGGER monitor_invalidate_period AFTER UPDATE OF generation ON monitors
WHEN NEW.generation != OLD.generation AND (NEW.config != OLD.config OR NEW.status = 'archived')
BEGIN
  UPDATE monitor_periods SET closed_at = CAST(unixepoch('subsec') * 1000 AS INTEGER), disposition = 'configuration_changed'
  WHERE closed_at IS NULL AND group_id IN (SELECT id FROM groups WHERE monitor_id = NEW.id);

  UPDATE groups SET status = 'resolved', substatus = NULL, resolved_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
  WHERE monitor_id = NEW.id AND status = 'unresolved';
END;

CREATE TABLE monitor_audit (
  monitor_id  TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  actor_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  happened_at INTEGER NOT NULL,
  snapshot    TEXT NOT NULL,
  PRIMARY KEY (monitor_id, version)
) WITHOUT ROWID;
CREATE INDEX monitor_audit_retention ON monitor_audit(happened_at);

CREATE TRIGGER monitor_audit_new AFTER INSERT ON monitors BEGIN
  INSERT INTO monitor_audit VALUES(NEW.id, NEW.version, NEW.changed_by, NEW.created_at,
    json_object('type',NEW.type,'name',NEW.name,'description',NEW.description,'ownerId',NEW.owner_id,
      'status',NEW.status,'config',json(NEW.config),'alertRuleIds',json(NEW.alert_rule_ids),'notify',NEW.notify));
END;

CREATE TRIGGER monitor_audit_edit AFTER UPDATE OF version ON monitors WHEN NEW.version != OLD.version
BEGIN
  INSERT INTO monitor_audit VALUES(NEW.id, NEW.version, NEW.changed_by, NEW.changed_at,
    json_object('type',NEW.type,'name',NEW.name,'description',NEW.description,'ownerId',NEW.owner_id,
      'status',NEW.status,'config',json(NEW.config),'alertRuleIds',json(NEW.alert_rule_ids),'notify',NEW.notify,
      'mutedUntil',NEW.muted_until));
END;

CREATE TABLE monitor_alert_rules (
  id              TEXT PRIMARY KEY NOT NULL,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  config          TEXT NOT NULL CHECK (json_valid(config)),
  version         INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX monitor_alert_rules_org ON monitor_alert_rules(organization_id, name);

CREATE TABLE monitor_transitions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  observation_id INTEGER REFERENCES monitor_observations(id) ON DELETE SET NULL,
  generation     INTEGER NOT NULL,
  period_id      INTEGER REFERENCES monitor_periods(id) ON DELETE SET NULL,
  monitor_id     TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  scope          TEXT NOT NULL,
  happened_at    INTEGER NOT NULL,
  type           TEXT NOT NULL CHECK (type IN ('failure','escalation','recovery')),
  evidence       TEXT NOT NULL
);
-- Pruning observations and periods follows these foreign keys; without the
-- indexes each delete would scan the transitions table.
CREATE INDEX monitor_transitions_observation ON monitor_transitions(observation_id);
CREATE INDEX monitor_transitions_period ON monitor_transitions(period_id);
CREATE INDEX monitor_transitions_retention ON monitor_transitions(happened_at);

-- `transition_type` is the transition as this rule sees it. For a rule that
-- pages only on high priority, the first escalation to high in an incident is
-- that rule's failure, and its recovery is sent only if that rule paged.
CREATE TABLE monitor_deliveries (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  transition_id   INTEGER NOT NULL REFERENCES monitor_transitions(id) ON DELETE CASCADE,
  group_id        INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  rule_id         TEXT NOT NULL REFERENCES monitor_alert_rules(id) ON DELETE CASCADE,
  channel         TEXT NOT NULL CHECK (channel IN ('email','push')),
  happened_at     INTEGER NOT NULL,
  transition_type TEXT NOT NULL,
  suppression     TEXT,
  UNIQUE (transition_id, rule_id, channel)
);
CREATE INDEX monitor_delivery_throttle ON monitor_deliveries(group_id, rule_id, channel, transition_type, happened_at DESC)
  WHERE suppression IS NULL;

-- Capture the transition before the issue trigger changes its previous state.
CREATE TRIGGER monitor_group_transition AFTER UPDATE OF status, level ON groups
WHEN NEW.monitor_id IS NOT NULL AND EXISTS(
  SELECT 1 FROM monitors WHERE id = NEW.monitor_id AND status = 'active'
) AND (NEW.status != OLD.status OR (NEW.status = 'unresolved' AND NEW.level = 'error' AND OLD.level = 'warning') OR (OLD.times_seen = 0 AND NEW.times_seen = 1))
BEGIN
  INSERT INTO monitor_transitions(observation_id, generation, period_id, monitor_id, scope, happened_at, type, evidence)
  SELECT id, generation, (SELECT p.id FROM monitor_periods p WHERE group_id = NEW.id
    AND (p.closed_at IS NULL OR (NEW.status = 'resolved' AND p.closed_at = NEW.resolved_at))
    ORDER BY p.id DESC LIMIT 1), NEW.monitor_id, NEW.monitor_scope, evaluated_at, CASE
    WHEN NEW.status = 'resolved' THEN 'recovery'
    WHEN OLD.times_seen > 0 AND OLD.status = NEW.status THEN 'escalation'
    ELSE 'failure' END,
    json_set(evidence,'$.severity',CASE WHEN (CASE NEW.status WHEN 'resolved' THEN OLD.level ELSE NEW.level END) = 'warning'
      THEN 'medium' ELSE 'high' END)
  FROM monitor_observations WHERE monitor_id = NEW.monitor_id AND scope = NEW.monitor_scope
    AND ((NEW.status = 'resolved' AND health = 'healthy' AND evaluated_at = NEW.resolved_at) OR
         (NEW.status = 'unresolved' AND health = 'failing' AND evaluated_at = NEW.last_seen))
  ORDER BY id DESC LIMIT 1;
END;

-- One delivery row per linked rule and channel: suppressed with a reason, or
-- queued to the outbox. Recovery is never throttled, because a throttled
-- recovery would leave "failing" as the last thing anyone was told.
CREATE TRIGGER monitor_transition_deliver AFTER INSERT ON monitor_transitions
BEGIN
  INSERT INTO monitor_deliveries (transition_id, group_id, rule_id, channel, happened_at, transition_type, suppression)
  SELECT NEW.id, c.group_id, r.id, c.channel, NEW.happened_at, c.effective,
    CASE
      WHEN m.notify = 0 OR m.status != 'active' THEN 'disabled'
      WHEN m.muted_until > NEW.happened_at THEN 'muted'
      WHEN NOT json_extract(r.config,'$.enabled') THEN 'rule_disabled'
      WHEN json_extract(r.config,'$.environment') IS NOT NULL AND json_extract(r.config,'$.environment') IS NOT COALESCE(NULLIF(NEW.scope,''),json_extract(m.config,'$.environment')) THEN 'environment'
      WHEN json_extract(r.config,'$.priority') = 'high' AND NEW.type != 'recovery' AND json_extract(NEW.evidence,'$.severity') IS NOT 'high' THEN 'priority'
      WHEN json_extract(r.config,'$.priority') = 'high' AND NEW.type = 'recovery' AND NOT c.paged THEN 'priority'
      WHEN NOT EXISTS (SELECT 1 FROM json_each(r.config,'$.triggers') WHERE value = c.effective) THEN 'trigger'
      WHEN c.effective != 'recovery' AND EXISTS (SELECT 1 FROM monitor_deliveries prior WHERE prior.group_id = c.group_id
        AND prior.rule_id = r.id AND prior.channel = c.channel AND prior.transition_type = c.effective
        AND prior.suppression IS NULL
        AND prior.happened_at > NEW.happened_at - json_extract(r.config,'$.throttleSeconds') * 1000) THEN 'throttled'
      ELSE NULL END
  FROM (
    SELECT g.id AS group_id, rule.id AS rule_id, channels.value AS channel,
      -- Whether this rule already paged on this channel in the current incident period.
      EXISTS (SELECT 1 FROM monitor_deliveries prior JOIN monitor_transitions t ON t.id = prior.transition_id
        WHERE prior.group_id = g.id AND prior.rule_id = rule.id AND prior.channel = channels.value
          AND prior.suppression IS NULL AND prior.transition_type IN ('failure','escalation')
          AND t.period_id IS NEW.period_id) AS paged,
      CASE WHEN json_extract(rule.config,'$.priority') = 'high' AND NEW.type = 'escalation'
        AND NOT EXISTS (SELECT 1 FROM monitor_deliveries prior JOIN monitor_transitions t ON t.id = prior.transition_id
          WHERE prior.group_id = g.id AND prior.rule_id = rule.id AND prior.channel = channels.value
            AND prior.suppression IS NULL AND t.period_id IS NEW.period_id)
        THEN 'failure' ELSE NEW.type END AS effective
    FROM monitors mm JOIN projects p ON p.id = mm.project_id
    JOIN groups g ON g.monitor_id = mm.id AND g.monitor_scope = NEW.scope
    JOIN json_each(mm.alert_rule_ids) links
    JOIN monitor_alert_rules rule ON rule.id = links.value AND rule.organization_id = p.organization_id
    JOIN json_each(rule.config,'$.channels') channels
    WHERE mm.id = NEW.monitor_id
  ) c
  JOIN monitors m ON m.id = NEW.monitor_id
  JOIN monitor_alert_rules r ON r.id = c.rule_id;

  INSERT INTO notify_outbox(kind, organization_id, project_id, group_id, data, created_at)
  SELECT 'status', p.organization_id, m.project_id, d.group_id, json_object('monitorDeliveryId', d.id),
    CAST(unixepoch('subsec') * 1000 AS INTEGER)
  FROM monitor_deliveries d JOIN monitors m ON m.id = NEW.monitor_id
  JOIN projects p ON p.id = m.project_id
  WHERE d.transition_id = NEW.id AND d.suppression IS NULL;
END;

CREATE TABLE monitor_previews (
  id              TEXT PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  config          TEXT NOT NULL,
  expires_at      INTEGER NOT NULL,
  started_at      INTEGER,
  result          TEXT
);
CREATE INDEX monitor_previews_expiry ON monitor_previews(expires_at);
