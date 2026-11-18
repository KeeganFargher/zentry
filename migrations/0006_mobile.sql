-- The mobile app (DESIGN.md §19): signing a phone in with a QR code, the
-- device tokens it then calls the API with, and push notifications.

-- A short-lived, single-use code shown as a QR code in the web UI. The phone
-- trades it for a device token. Only the code's hash is kept, so a database
-- read does not hand out a code that still works.
CREATE TABLE device_pairings (
  code_hash   TEXT    PRIMARY KEY,       -- SHA-256 hex of the code
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX device_pairings_by_expiry ON device_pairings(expires_at);

-- A signed-in phone. Its bearer token is stored hashed, as above. Signing out
-- or revoking deletes the row, which ends the token and its pushes at once.
-- A token unused for 30 days stops working (src/api/router.ts), so a phone
-- left behind does not keep access for ever. AUTOINCREMENT, because a
-- push_sends row names its device by id after the device is gone, and a
-- reused id would point it at someone else's phone.
CREATE TABLE devices (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT    NOT NULL UNIQUE,
  name          TEXT    NOT NULL,
  push_token    TEXT,                    -- ExponentPushToken[…]; null until the app registers one
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);
CREATE INDEX devices_by_user ON devices(user_id);
-- A push token belongs to one install. When a phone signs in again, the
-- token moves to the new row instead of notifying the old session too.
CREATE UNIQUE INDEX devices_by_push_token ON devices(push_token) WHERE push_token IS NOT NULL;

-- One row per push to one device, keyed like email_sends, so a queue
-- redelivery never pushes twice. `ticket_id` is Expo's receipt id; the hourly
-- cron reads the receipt and settles the row as delivered or failed. A
-- receipt saying the install is gone forgets `push_token`, not the device: the
-- phone may have registered a new token since.
CREATE TABLE push_sends (
  key         TEXT    PRIMARY KEY,
  device_id   INTEGER NOT NULL,          -- not a foreign key: the record outlives a revoked device
  push_token  TEXT    NOT NULL,          -- the token the push went to
  status      TEXT    NOT NULL CHECK (status IN ('sending', 'sent', 'delivered', 'failed')),
  ticket_id   TEXT,
  error       TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX push_sends_by_created ON push_sends(created_at);
CREATE INDEX push_sends_awaiting_receipt ON push_sends(created_at) WHERE status = 'sent';

-- Push joins email as a provider of notification settings. SQLite cannot
-- change a CHECK constraint in place, so the table is rebuilt.
CREATE TABLE notification_settings_new (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider    TEXT    NOT NULL CHECK (provider IN ('email', 'push')),
  type        TEXT    NOT NULL
              CHECK (type IN ('alerts', 'workflow', 'quota', 'spikeProtection', 'reports')),
  scope       TEXT    NOT NULL CHECK (scope IN ('user', 'organization', 'project')),
  scope_id    INTEGER NOT NULL,
  value       TEXT    NOT NULL CHECK (value IN ('always', 'never', 'subscribe_only')),
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, provider, type, scope, scope_id)
) WITHOUT ROWID;

INSERT INTO notification_settings_new
  SELECT user_id, provider, type, scope, scope_id, value, updated_at FROM notification_settings;

DROP TABLE notification_settings;

ALTER TABLE notification_settings_new RENAME TO notification_settings;

-- A row whose send a provider deferred (§19.2) steps aside until then, so a
-- long email outage does not keep the rows behind it, and their pushes, from
-- being drained.
ALTER TABLE notify_outbox ADD COLUMN deferred_until INTEGER NOT NULL DEFAULT 0;
