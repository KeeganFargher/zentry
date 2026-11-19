-- A minute can only support recovery or a below-threshold alert after every
-- accepted input for that minute has left the event pipeline.
CREATE TABLE metric_pending (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, event_id)
) WITHOUT ROWID;
CREATE INDEX metric_pending_window ON metric_pending(project_id, received_at);
CREATE INDEX metric_pending_retention ON metric_pending(received_at);

CREATE TABLE metric_capture (
  project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  started_at INTEGER NOT NULL
);

INSERT INTO metric_capture
SELECT DISTINCT project_id, CAST(unixepoch('subsec') * 1000 AS INTEGER)
FROM monitors WHERE type = 'metric' AND status != 'archived';

CREATE TRIGGER metric_capture_started AFTER INSERT ON monitors
WHEN NEW.type = 'metric'
BEGIN
  INSERT OR IGNORE INTO metric_capture(project_id, started_at) VALUES (NEW.project_id, NEW.created_at);
END;

CREATE TRIGGER metric_capture_stopped AFTER UPDATE OF status ON monitors
WHEN NEW.type = 'metric' AND NEW.status = 'archived'
BEGIN
  DELETE FROM metric_capture WHERE project_id = NEW.project_id AND NOT EXISTS (
    SELECT 1 FROM monitors WHERE project_id = NEW.project_id AND type = 'metric' AND status != 'archived'
  );
END;

ALTER TABLE metric_receipts ADD COLUMN level TEXT NOT NULL DEFAULT 'error';

CREATE TABLE metric_level_minutes (
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  minute INTEGER NOT NULL,
  environment TEXT NOT NULL,
  level TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (project_id, minute, environment, level)
) WITHOUT ROWID;
CREATE INDEX metric_level_retention ON metric_level_minutes(minute);

DROP TRIGGER metric_receipt_rollup;
CREATE TRIGGER metric_receipt_rollup AFTER INSERT ON metric_receipts
BEGIN
  INSERT INTO metric_level_minutes (project_id, minute, environment, level, count)
  VALUES (NEW.project_id, NEW.minute, NEW.environment, NEW.level, 1)
  ON CONFLICT(project_id, minute, environment, level) DO UPDATE SET count = count + 1;
END;

ALTER TABLE monitors ADD COLUMN evaluation_after INTEGER NOT NULL DEFAULT 0;
ALTER TABLE monitors ADD COLUMN severity TEXT CHECK (severity IN ('medium', 'high'));
