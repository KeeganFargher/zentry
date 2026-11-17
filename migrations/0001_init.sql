-- ── Tenancy ────────────────────────────────────────────────────────────────
CREATE TABLE organizations (
  id          INTEGER PRIMARY KEY,
  slug        TEXT    NOT NULL UNIQUE,
  name        TEXT    NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE users (                       -- created on first request from the Access JWT
  id            INTEGER PRIMARY KEY,
  email         TEXT    NOT NULL UNIQUE,   -- lower-cased
  name          TEXT,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);

CREATE TABLE organization_members (
  organization_id  INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role             TEXT    NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
  created_at       INTEGER NOT NULL,
  PRIMARY KEY (organization_id, user_id)
) WITHOUT ROWID;
CREATE INDEX organization_members_user ON organization_members(user_id);

CREATE TABLE projects (
  id                   INTEGER PRIMARY KEY,
  organization_id      INTEGER NOT NULL REFERENCES organizations(id),
  slug                 TEXT    NOT NULL,           -- 'api', 'web'; upper-cased for short ids
  name                 TEXT    NOT NULL,
  platform             TEXT,
  next_short_id        INTEGER NOT NULL DEFAULT 0,
  max_events_per_hour  INTEGER DEFAULT 10000,      -- NULL = unlimited
  rate_limited_until   INTEGER,                    -- ms; ingest returns 429 until then
  first_event_at       INTEGER,
  created_at           INTEGER NOT NULL,
  UNIQUE (organization_id, slug)
);

CREATE TABLE project_keys (
  id          INTEGER PRIMARY KEY,
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  public_key  TEXT    NOT NULL UNIQUE,             -- 32 hex
  label       TEXT    NOT NULL DEFAULT 'Default',
  status      TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_at  INTEGER NOT NULL
);
CREATE INDEX project_keys_project ON project_keys(project_id);

-- ── Issues ─────────────────────────────────────────────────────────────────
CREATE TABLE groups (
  id             INTEGER PRIMARY KEY,
  project_id     INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  short_id       INTEGER NOT NULL,
  primary_hash   TEXT    NOT NULL,                 -- the hash that created the issue
  title          TEXT    NOT NULL,
  culprit        TEXT    NOT NULL DEFAULT '',
  level          TEXT    NOT NULL DEFAULT 'error',
  platform       TEXT,
  metadata       TEXT    NOT NULL DEFAULT '{}',    -- JSON {type,value,filename,function}
  status         TEXT    NOT NULL DEFAULT 'unresolved'
                 CHECK (status IN ('unresolved','resolved','ignored')),
  substatus      TEXT    CHECK (substatus IN ('regressed')),
  times_seen     INTEGER NOT NULL DEFAULT 0,
  first_seen     INTEGER NOT NULL,
  last_seen      INTEGER NOT NULL,
  resolved_at    INTEGER,
  resolved_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  last_event_id  TEXT,
  first_release  TEXT,
  created_at     INTEGER NOT NULL,
  UNIQUE (project_id, primary_hash),
  UNIQUE (project_id, short_id)
);
-- Issue list, default sort.
CREATE INDEX groups_by_last_seen  ON groups(project_id, status, last_seen DESC, id DESC);
-- Issue list sorted by age. first_seen almost never changes, so this is cheap to maintain.
CREATE INDEX groups_by_first_seen ON groups(project_id, status, first_seen DESC, id DESC);
-- No index on times_seen: it changes on every event. That sort reads the
-- project's rows for one status and sorts them.

CREATE TABLE grouphashes (                 -- many hashes can point at one issue (merge)
  project_id       INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  hash             TEXT    NOT NULL,
  group_id         INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  grouping_config  TEXT    NOT NULL,
  created_at       INTEGER NOT NULL,
  PRIMARY KEY (project_id, hash)
) WITHOUT ROWID;
CREATE INDEX grouphashes_group ON grouphashes(group_id);

CREATE TABLE activity (                    -- resolved / unresolved / ignored / regressed / merged
  id          INTEGER PRIMARY KEY,
  group_id    INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  project_id  INTEGER NOT NULL,
  type        TEXT    NOT NULL,
  user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,   -- NULL = system
  data        TEXT    NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL
);
CREATE INDEX activity_by_group ON activity(group_id, created_at DESC);

-- ── Events (index only; the full JSON is in R2) ────────────────────────────
CREATE TABLE events (
  project_id   INTEGER NOT NULL,
  event_id     TEXT    NOT NULL,
  group_id     INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  ts           INTEGER NOT NULL,           -- event time
  received_at  INTEGER NOT NULL,
  level        TEXT,
  platform     TEXT,
  release      TEXT,
  environment  TEXT,
  user_label   TEXT,
  title        TEXT,
  size_bytes   INTEGER,
  PRIMARY KEY (project_id, event_id)
) WITHOUT ROWID;
-- Latest / oldest / previous / next within an issue, and the issue's event list.
CREATE INDEX events_by_group    ON events(group_id, ts DESC, event_id);
-- Retention deletes oldest first.
CREATE INDEX events_by_received ON events(received_at);

-- ── Aggregates ─────────────────────────────────────────────────────────────
CREATE TABLE group_stats (                 -- hourly; drives sparklines and flood sampling
  group_id    INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  bucket      INTEGER NOT NULL,            -- ms at the start of the hour
  project_id  INTEGER NOT NULL,
  count       INTEGER NOT NULL DEFAULT 0,  -- all events
  stored      INTEGER NOT NULL DEFAULT 0,  -- events kept in full
  PRIMARY KEY (group_id, bucket)
) WITHOUT ROWID;

CREATE TABLE project_stats (               -- hourly; drives the quota and the project chart
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  bucket      INTEGER NOT NULL,
  received    INTEGER NOT NULL DEFAULT 0,
  stored      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, bucket)
) WITHOUT ROWID;

CREATE TABLE group_tag_values (
  group_id    INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  key         TEXT    NOT NULL,
  value       TEXT    NOT NULL,
  project_id  INTEGER NOT NULL,
  times_seen  INTEGER NOT NULL DEFAULT 0,
  first_seen  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  PRIMARY KEY (group_id, key, value)
) WITHOUT ROWID;
-- "Issues where environment = production" and other tag filters.
-- Its columns never change after insert, so counter updates do not rewrite it.
CREATE INDEX group_tag_values_filter ON group_tag_values(project_id, key, value, group_id);

-- ── Seed ───────────────────────────────────────────────────────────────────
INSERT INTO organizations (id, slug, name, created_at)
VALUES (1, 'default', 'Default', unixepoch() * 1000);
