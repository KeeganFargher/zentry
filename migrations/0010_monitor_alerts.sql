ALTER TABLE monitors ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE monitors ADD COLUMN owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE monitors ADD COLUMN muted_until INTEGER;
ALTER TABLE monitors ADD COLUMN alert_rule_ids TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(alert_rule_ids));
ALTER TABLE monitors ADD COLUMN changed_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE monitors ADD COLUMN changed_at INTEGER;
ALTER TABLE monitors ADD COLUMN request_key TEXT;
CREATE UNIQUE INDEX monitor_request_key ON monitors(project_id, request_key) WHERE request_key IS NOT NULL;

CREATE TABLE monitor_audit (
  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  happened_at INTEGER NOT NULL,
  snapshot TEXT NOT NULL,
  PRIMARY KEY(monitor_id, version)
) WITHOUT ROWID;

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
  id TEXT PRIMARY KEY NOT NULL,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  config TEXT NOT NULL CHECK (json_valid(config)),
  version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX monitor_alert_rules_org ON monitor_alert_rules(organization_id, name);

CREATE TABLE monitor_transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  observation_id INTEGER REFERENCES monitor_observations(id) ON DELETE SET NULL,
  generation INTEGER NOT NULL,
  period_id INTEGER REFERENCES monitor_periods(id) ON DELETE SET NULL,
  monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  happened_at INTEGER NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('failure','escalation','recovery')),
  evidence TEXT NOT NULL
);

CREATE TABLE monitor_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transition_id INTEGER NOT NULL REFERENCES monitor_transitions(id) ON DELETE CASCADE,
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  rule_id TEXT NOT NULL REFERENCES monitor_alert_rules(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK(channel IN ('email','push')),
  happened_at INTEGER NOT NULL,
  transition_type TEXT NOT NULL,
  suppression TEXT,
  UNIQUE(transition_id, rule_id, channel)
);
CREATE INDEX monitor_delivery_throttle ON monitor_deliveries(group_id, rule_id, channel, transition_type, happened_at DESC)
  WHERE suppression IS NULL;

DROP TRIGGER monitor_cancel_delivery;

CREATE TRIGGER monitor_transition_deliver AFTER INSERT ON monitor_transitions
BEGIN
  INSERT INTO monitor_deliveries (transition_id, group_id, rule_id, channel, happened_at, transition_type, suppression)
  SELECT NEW.id, g.id, r.id, channels.value, NEW.happened_at, NEW.type,
    CASE
      WHEN m.notify = 0 OR m.status != 'active' THEN 'disabled'
      WHEN m.muted_until > NEW.happened_at THEN 'muted'
      WHEN NOT json_extract(r.config,'$.enabled') THEN 'rule_disabled'
      WHEN json_extract(r.config,'$.environment') IS NOT NULL AND json_extract(r.config,'$.environment') IS NOT COALESCE(NULLIF(NEW.scope,''),json_extract(m.config,'$.environment')) THEN 'environment'
      WHEN json_extract(r.config,'$.priority') = 'high' AND json_extract(NEW.evidence,'$.severity') IS NOT 'high' THEN 'priority'
      WHEN NOT EXISTS (SELECT 1 FROM json_each(r.config,'$.triggers') WHERE value = NEW.type) THEN 'trigger'
      WHEN EXISTS (SELECT 1 FROM monitor_deliveries prior WHERE prior.group_id = g.id AND prior.rule_id = r.id
        AND prior.channel = channels.value AND prior.transition_type = NEW.type AND prior.suppression IS NULL
        AND prior.happened_at > NEW.happened_at - json_extract(r.config,'$.throttleSeconds') * 1000) THEN 'throttled'
      ELSE NULL END
  FROM monitors m JOIN projects p ON p.id = m.project_id
  JOIN groups g ON g.monitor_id = m.id AND g.monitor_scope = NEW.scope
  JOIN json_each(m.alert_rule_ids) links
  JOIN monitor_alert_rules r ON r.id = links.value AND r.organization_id = p.organization_id
  JOIN json_each(r.config,'$.channels') channels
  WHERE m.id = NEW.monitor_id;

  INSERT INTO notify_outbox(kind, organization_id, project_id, group_id, data, created_at)
  SELECT 'status', p.organization_id, m.project_id, d.group_id, json_object('monitorDeliveryId', d.id),
    CAST(unixepoch('subsec') * 1000 AS INTEGER)
  FROM monitor_deliveries d JOIN monitors m ON m.id = NEW.monitor_id
  JOIN projects p ON p.id = m.project_id
  WHERE d.transition_id = NEW.id AND d.suppression IS NULL;
END;

-- Capture the transition before the issue trigger changes its previous state.
-- Newly created groups are handled at the point of creation below.
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
