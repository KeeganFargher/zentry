// The issue list's filters in one line, for the collapsed header.

import type { ApiProject } from "@contract";

import { LEVELS, STATUSES } from "./filters";
import type { Choice, Filters } from "./filters";

function labelOf<T>(choices: Choice<T>[], value: T): string | undefined {
  return choices.find((choice) => choice.value === value)?.label;
}

/**
 * The filters in a line, for the collapsed header: "Unresolved · All
 * Projects", then the level and search only when they narrow the list.
 */
export function filterSummary(filters: Filters, projects: ApiProject[]): string {
  const project =
    filters.project === null
      ? "All Projects"
      : // As in the dropdown: a push can set a project before the list has loaded.
        (projects.find((candidate) => candidate.id === filters.project)?.name ?? "Project");

  const parts = [labelOf(STATUSES, filters.status) ?? filters.status, project];

  if (filters.level !== null) {
    parts.push(labelOf(LEVELS, filters.level) ?? filters.level);
  }

  if (filters.query.trim() !== "") {
    parts.push(`"${filters.query.trim()}"`);
  }

  return parts.join(" · ");
}
