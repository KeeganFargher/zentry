CREATE TABLE monitor_previews (
  id TEXT PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  config TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  started_at INTEGER,
  result TEXT
);

CREATE INDEX monitor_previews_expiry ON monitor_previews(expires_at);
