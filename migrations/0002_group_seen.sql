-- When each user last opened each issue. An issue is unread for a user until
-- they open it, and again after it regresses.
CREATE TABLE group_seen (
  user_id     INTEGER NOT NULL REFERENCES users(id)  ON DELETE CASCADE,
  group_id    INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  project_id  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  PRIMARY KEY (user_id, group_id)
) WITHOUT ROWID;
-- Deleting an issue removes its rows without scanning the table.
CREATE INDEX group_seen_by_group ON group_seen(group_id);
