-- Spend limits (DESIGN.md §6): a monthly event cap per organization, spike
-- protection per project, and the reason a project is rate limited.

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

-- The ceiling on the bill: once the organization's projects have sent this
-- many events in a UTC month, ingest refuses them all until the month ends.
-- Set in the organization's settings page; it also sets the spike floor.
ALTER TABLE organizations ADD COLUMN max_events_per_month INTEGER NOT NULL DEFAULT 1000000
  CHECK (max_events_per_month > 0);

-- Hourly spike threshold. Every project has one from the moment it exists:
-- project creation sets the floor, and the hourly cron recomputes it from the
-- last 7 days. The DEFAULT only satisfies ALTER TABLE; the UPDATE below
-- replaces it for every existing row.
ALTER TABLE projects ADD COLUMN spike_limit_per_hour INTEGER NOT NULL DEFAULT 0;

-- Existing projects get an upper bound of what the cron can compute: the
-- floor, or six times (the largest multiplier) their busiest hour of the last
-- week, whichever is higher. The projection can never exceed the busiest hour,
-- so no project is refused because of this seed; the first hourly run then
-- brings each threshold down to its real value. The floor is
-- max(500, ⌈3 × cap / (720 × min(projects, 5))⌉), as in core/spike.ts.
UPDATE projects SET spike_limit_per_hour = max(
  500,
  (SELECT (3 * o.max_events_per_month + 720 * c.n - 1) / (720 * c.n)
   FROM organizations o,
        (SELECT min(max(count(*), 1), 5) AS n FROM projects p
         WHERE p.organization_id = projects.organization_id) AS c
   WHERE o.id = projects.organization_id),
  6 * (SELECT COALESCE(max(ps.received), 0) FROM project_stats ps
       WHERE ps.project_id = projects.id
         AND ps.bucket >= (unixepoch('now') - 7 * 86400) * 1000)
);

-- Events accepted per organization per UTC month. One row per month, so the
-- ingest check reads one row and each consumer batch writes one per organization.
CREATE TABLE usage_months (
  organization_id  INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  month            INTEGER NOT NULL,      -- ms at the start of the UTC month
  received         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (organization_id, month)
) WITHOUT ROWID;

-- Seed the current month from the hourly counts already recorded, so that
-- deploying the cap mid-month does not grant a second full allowance.
-- project_stats buckets use the receive time, as usage_months does.
INSERT INTO usage_months (organization_id, month, received)
SELECT p.organization_id, unixepoch('now', 'start of month') * 1000, sum(ps.received)
FROM project_stats ps JOIN projects p ON p.id = ps.project_id
WHERE ps.bucket >= unixepoch('now', 'start of month') * 1000
GROUP BY p.organization_id;
