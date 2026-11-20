-- Auth tokens for sentry-cli (DESIGN.md §20). A member makes one in the web
-- UI for one organization; the CLI sends it as `Authorization: Bearer`.
-- Only its SHA-256 is kept, as with device tokens, so a database read does
-- not hand out a token that still works. Revoking deletes the row.
--
-- A token acts as the member who made it: issue status changes it makes are
-- theirs in the activity feed. Membership is checked on every request too.
-- There is no idle limit, unlike phones: a CI job may run once a quarter, and
-- a token that silently stopped working would break the release that needs it.
CREATE TABLE cli_tokens (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id  INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name             TEXT    NOT NULL,
  token_hash       TEXT    NOT NULL UNIQUE,  -- SHA-256 hex of the whole token
  token_hint       TEXT    NOT NULL,         -- its last four characters, to tell tokens apart
  created_at       INTEGER NOT NULL,
  last_used_at     INTEGER                   -- null until first used; written at most hourly
);
CREATE INDEX cli_tokens_by_user ON cli_tokens(user_id, organization_id);

-- A token belongs to a membership, not just a user and an organization:
-- removing the member deletes their tokens, so being added back later does
-- not revive them. Zentry has no code that removes members yet; this holds
-- for whatever does it, SQL by hand included.
CREATE TRIGGER cli_tokens_end_with_membership AFTER DELETE ON organization_members
BEGIN
  DELETE FROM cli_tokens WHERE user_id = OLD.user_id AND organization_id = OLD.organization_id;
END;

-- `sentry-cli events list`: a project's events, newest first. The cost is one
-- more index write per stored event; without it the list would read and sort
-- every event the project has.
CREATE INDEX events_by_project ON events(project_id, ts DESC, event_id);
