-- Spend limits (DESIGN.md §6): spike protection per project, the reason a
-- project is rate limited, and the installation-wide monthly event count.

-- A limit set before this migration has no reason. It lasts at most until the
-- end of its hour and the next batch over quota sets it again, so clearing it
-- loses nothing and lets the CHECK below hold for every row.
UPDATE projects SET rate_limited_until = NULL;

-- Why ingest is refusing the project, in Relay's reason codes. Set and cleared
-- together with rate_limited_until, so the UI can always say why.
ALTER TABLE projects ADD COLUMN rate_limit_reason TEXT
  CHECK ((rate_limit_reason IS NULL) = (rate_limited_until IS NULL)
         AND (rate_limit_reason IS NULL
              OR rate_limit_reason IN ('project_quota', 'spike_protection')));

-- On by default, as in Sentry. Turned off for projects that are bursty by design.
ALTER TABLE projects ADD COLUMN spike_protection INTEGER NOT NULL DEFAULT 1
  CHECK (spike_protection IN (0, 1));

-- Hourly spike threshold, recomputed by the hourly cron from the last 7 days.
-- NULL until the cron has run once for the project.
ALTER TABLE projects ADD COLUMN spike_limit_per_hour INTEGER;

-- Events accepted per UTC month, all projects together. Ingest refuses every
-- event once the month's count reaches MAX_EVENTS_PER_MONTH. One row per month,
-- so the ingest check reads one row and each consumer batch writes one.
CREATE TABLE usage_months (
  month     INTEGER PRIMARY KEY,           -- ms at the start of the UTC month
  received  INTEGER NOT NULL DEFAULT 0
);
