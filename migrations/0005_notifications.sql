-- Email notifications (DESIGN.md §18): who wants what, what is waiting to be
-- sent, and what has been sent.

-- A user's choice for one notification type at one scope. The most specific
-- row wins: project over organization over user. No row means the default in
-- src/core/notify-settings.ts. `provider` leaves room for Slack later.
CREATE TABLE notification_settings (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider    TEXT    NOT NULL DEFAULT 'email' CHECK (provider IN ('email')),
  type        TEXT    NOT NULL
              CHECK (type IN ('alerts', 'workflow', 'quota', 'spikeProtection', 'reports')),
  scope       TEXT    NOT NULL CHECK (scope IN ('user', 'organization', 'project')),
  scope_id    INTEGER NOT NULL,          -- the user, organization or project id
  value       TEXT    NOT NULL CHECK (value IN ('always', 'never', 'subscribe_only')),
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, provider, type, scope, scope_id)
) WITHOUT ROWID;

-- Who follows an issue's workflow (resolved, archived, reopened). Acting on an
-- issue subscribes you; an explicit unsubscribe is a row with active = 0, which
-- later actions never overwrite.
CREATE TABLE issue_subscriptions (
  user_id     INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  group_id    INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  active      INTEGER NOT NULL CHECK (active IN (0, 1)),
  reason      TEXT    NOT NULL CHECK (reason IN ('status_change', 'manual')),
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, group_id)
) WITHOUT ROWID;
CREATE INDEX issue_subscriptions_by_group ON issue_subscriptions(group_id);

-- Things that happened and may need an email. Written in the same transaction
-- as the change itself, so a notification is never lost to a failed enqueue;
-- the notify consumer drains it and deletes each row once handled.
-- AUTOINCREMENT, because the id is part of each email's idempotency key and a
-- plain rowid would be reused once the table empties.
CREATE TABLE notify_outbox (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  kind             TEXT    NOT NULL
                   CHECK (kind IN ('new_issue', 'regression', 'status', 'quota', 'spike', 'weekly_report')),
  organization_id  INTEGER,
  project_id       INTEGER,
  group_id         INTEGER,
  actor_id         INTEGER,              -- the user who made the change; never notified
  data             TEXT    NOT NULL DEFAULT '{}',
  attempts         INTEGER NOT NULL DEFAULT 0,   -- failed tries; dropped after a few
  created_at       INTEGER NOT NULL
);

-- When each issue last alerted, per reason, so a flapping issue alerts at most
-- once per interval.
CREATE TABLE notify_state (
  group_id   INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  reason     TEXT    NOT NULL,
  last_sent  INTEGER NOT NULL,
  PRIMARY KEY (group_id, reason)
) WITHOUT ROWID;

-- A project's digest window: alerts that arrive while it is open wait in
-- digest_pending and go out together when it is due.
CREATE TABLE digest_windows (
  project_id  INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  started_at  INTEGER NOT NULL,          -- the last send
  due_at      INTEGER NOT NULL
);

CREATE TABLE digest_pending (
  project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  group_id    INTEGER NOT NULL REFERENCES groups(id)   ON DELETE CASCADE,
  reason      TEXT    NOT NULL CHECK (reason IN ('new_issue', 'regression')),
  added_at    INTEGER NOT NULL,
  PRIMARY KEY (project_id, group_id)
) WITHOUT ROWID;

-- One row per email, keyed by what it is about and who it is for, so a queue
-- redelivery never sends the same email twice. Pruned by retention.
CREATE TABLE email_sends (
  key         TEXT    PRIMARY KEY,
  user_id     INTEGER,
  kind        TEXT    NOT NULL,
  group_id    INTEGER,
  status      TEXT    NOT NULL CHECK (status IN ('sending', 'sent', 'suppressed', 'failed')),
  message_id  TEXT,
  error       TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX email_sends_by_created ON email_sends(created_at);

-- The first email each address got about each issue. Later ones set
-- In-Reply-To and References to it, because Cloudflare picks the Message-ID.
CREATE TABLE email_threads (
  address     TEXT    NOT NULL,
  group_id    INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  message_id  TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (address, group_id)
) WITHOUT ROWID;

-- Addresses not to send to until `until`. Cloudflare suppresses bounced and
-- complaining addresses itself and refuses the send; this remembers that, so
-- the consumer stops trying for a while.
CREATE TABLE email_suppressions (
  address     TEXT    PRIMARY KEY,
  reason      TEXT    NOT NULL CHECK (reason IN ('suppressed', 'bounced', 'complained')),
  until       INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
