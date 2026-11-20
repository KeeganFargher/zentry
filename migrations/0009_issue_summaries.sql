-- The plain-language summary Workers AI writes for an issue's push
-- (DESIGN.md §19.2). One row per issue, written the first time the issue is
-- pushed with a summary, and reused for its later pushes. A summary from an
-- older prompt version is written again the next time the issue is pushed.
--
-- Kept apart from `groups`, which every event batch updates: this row is
-- written once and read only when notifying.
CREATE TABLE issue_summaries (
  group_id        INTEGER PRIMARY KEY REFERENCES groups(id) ON DELETE CASCADE,
  prompt_version  INTEGER NOT NULL,
  model           TEXT    NOT NULL,   -- which model wrote it, to compare quality after a change
  headline        TEXT    NOT NULL,
  detail          TEXT    NOT NULL,
  event_id        TEXT,               -- the event it was written from; null when written from the issue alone
  created_at      INTEGER NOT NULL
);
