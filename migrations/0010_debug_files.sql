-- Source bundles uploaded with `sentry-cli debug-files upload` (DESIGN.md
-- §20.4). The bundle itself is in R2 under its debug id; this row records
-- that a file with this checksum was assembled, so the CLI's repeat of an
-- upload is answered "ok" without reading it again, as Sentry's
-- ProjectDebugFile table does.
--
-- Keyed by checksum, not debug id: a rebuild with changed sources but the
-- same debug id is a different file. The later one replaces the earlier in
-- R2, which is what the debug id then names.
CREATE TABLE debug_files (
  project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  checksum     TEXT    NOT NULL,  -- SHA-1 hex of the whole file, as the CLI names it
  debug_id     TEXT    NOT NULL,  -- lower-cased, from the bundle's manifest
  object_name  TEXT    NOT NULL,  -- the debug file the sources were read for ("Core.pdb")
  arch         TEXT    NOT NULL,
  size         INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (project_id, checksum)
);
