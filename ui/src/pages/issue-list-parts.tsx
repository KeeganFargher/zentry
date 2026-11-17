// Pieces of the issue list page that do not touch its data: the page title,
// the real-time switch and the empty states.

import type { ApiProject } from "@contract";
import { useEffect } from "react";
import type { JSX } from "react";

import { Link } from "~/components/basics";
import { Icon } from "~/components/icons";

const STATUS_VIEWS = new Map([
  ["resolved", "Resolved"],
  ["ignored", "Archived"],
  ["all", "All Issues"],
]);

const LEVEL_VIEWS = new Map([
  ["error", "Errors"],
  ["warning", "Warnings"],
]);

/** The name of the view the filters amount to, matching the side navigation. */
export function viewTitle(query: URLSearchParams, projects: ApiProject[]): string {
  const project = projects.find((entry) => String(entry.id) === query.get("project"));

  return (
    project?.name ??
    STATUS_VIEWS.get(query.get("status") ?? "") ??
    LEVEL_VIEWS.get(query.get("level") ?? "") ??
    "Feed"
  );
}

export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = `${title} — Zentry`;
  }, [title]);
}

type LiveProps = { on: boolean; onChange: (on: boolean) => void };

/** Sentry's play/pause button: while on, the first page refreshes every few seconds. */
export function LiveButton({ on, onChange }: LiveProps): JSX.Element {
  const label = on ? "Pause real-time updates" : "Enable real-time updates";

  return (
    <button
      type="button"
      className={on ? "small live on" : "small live"}
      aria-label={label}
      aria-pressed={on}
      title={label}
      onClick={() => onChange(!on)}
    >
      <Icon name={on ? "pause" : "play"} size={12} />
      {on ? "Live" : "Paused"}
    </button>
  );
}

type EmptyProps = { org: string; query: URLSearchParams; projects: ApiProject[] | null };

/** Only the project and status shortcuts are set: nothing to suggest but waiting. */
function isPlainView(query: URLSearchParams): boolean {
  return [...query.keys()].every((key) => key === "project" || key === "sort");
}

export function EmptyIssues({ org, query, projects }: EmptyProps): JSX.Element {
  const project = projects?.find((entry) => String(entry.id) === query.get("project"));

  if (projects !== null && projects.length === 0) {
    return (
      <div className="empty-state">
        <strong>Create a project to start collecting errors</strong>
        <span>Each project has its own DSN for the Sentry SDK.</span>
        <Link to={`/${org}/projects/`}>Create a project</Link>
      </div>
    );
  }

  if (project !== undefined && project.firstEventAt === null) {
    return (
      <div className="empty-state">
        <strong>Waiting for events…</strong>
        <span>{project.name} has not sent an event yet. Point an SDK at its DSN to begin.</span>
        <Link to={`/${org}/settings/projects/${project.slug}/`}>Show the DSN</Link>
      </div>
    );
  }

  if (isPlainView(query)) {
    return (
      <div className="empty-state">
        <strong>We couldn&apos;t find any issues that matched your filters.</strong>
        <span>Get out there and write some broken code!</span>
      </div>
    );
  }

  return (
    <div className="empty-state">
      <strong>No issues match your search</strong>
      <ul>
        <li>Check the search text for typos; it matches titles and locations.</li>
        <li>Try a wider status, such as All statuses.</li>
        <li>Remove the tag or level filter.</li>
      </ul>
    </div>
  );
}
