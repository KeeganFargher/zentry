// The issue list's filter bar. Every filter lives in the URL's query string.

import type { ApiProject } from "@contract";
import { useState } from "react";
import type { FormEvent, JSX } from "react";

import { Icon } from "~/components/icons";
import { readSetting, writeSetting } from "~/lib/storage";

type FiltersProps = {
  query: URLSearchParams;
  projects: ApiProject[];
  onSet: (key: string, value: string) => void;
  /** Removes the filter from the URL, so it takes its default. */
  onClear: (key: string) => void;
};

type Choose = (key: string, value: string, fallback: string) => void;

/** Sets `key`, or clears it when `value` is the filter's default. */
function chooser(props: FiltersProps): Choose {
  return (key, value, fallback) => {
    if (value === fallback) {
      props.onClear(key);
    } else {
      props.onSet(key, value);
    }
  };
}

const STATUSES = [
  ["unresolved", "Unresolved"],
  ["resolved", "Resolved"],
  ["ignored", "Archived"],
  ["all", "All statuses"],
];

const SORTS = [
  ["date", "Last Seen"],
  ["new", "Age"],
  ["freq", "Events"],
];

/** The sort last chosen, used whenever the URL does not name one. */
export const SORT_SETTING = "issue-sort";

const LEVELS = ["fatal", "error", "warning", "info", "debug"];

function PageFilters(props: FiltersProps): JSX.Element {
  const { query, projects } = props;

  return (
    <div className="joined">
      <select
        aria-label="Project"
        value={query.get("project") ?? ""}
        onChange={(event) => chooser(props)("project", event.target.value, "")}
      >
        <option value="">All Projects</option>
        {projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </select>
      <select
        aria-label="Level"
        value={query.get("level") ?? ""}
        onChange={(event) => chooser(props)("level", event.target.value, "")}
      >
        <option value="">All Levels</option>
        {LEVELS.map((level) => (
          <option key={level}>{level}</option>
        ))}
      </select>
      <select
        aria-label="Status"
        value={query.get("status") ?? "unresolved"}
        onChange={(event) => chooser(props)("status", event.target.value, "unresolved")}
      >
        {STATUSES.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
    </div>
  );
}

type TokenProps = { name: string; value: string; onRemove: () => void };

function Token({ name, value, onRemove }: TokenProps): JSX.Element {
  return (
    <span className="token">
      {name} <em>{value}</em>
      <button
        type="button"
        className="plain"
        aria-label={`Remove ${name} filter`}
        onClick={onRemove}
      >
        ×
      </button>
    </span>
  );
}

/** The search box: the active status and tag as removable tokens, then free text. */
function Search(props: FiltersProps): JSX.Element {
  const { query, onSet, onClear } = props;
  const [text, setText] = useState(query.get("query") ?? "");
  const status = query.get("status") ?? "unresolved";
  const tag = query.get("tag");

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    chooser(props)("query", text.trim(), "");
  };

  return (
    <div className="searchbox">
      <Icon name="search" />
      {status !== "all" && (
        <Token name="is" value={status} onRemove={() => onSet("status", "all")} />
      )}
      {tag !== null && <Token name="tag" value={tag} onRemove={() => onClear("tag")} />}
      <form onSubmit={submit}>
        <input
          type="search"
          aria-label="Search issues"
          placeholder="Search issues by title or location…"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      </form>
    </div>
  );
}

export function IssueFilters(props: FiltersProps): JSX.Element {
  const { query } = props;

  return (
    <div className="filters">
      <PageFilters {...props} />
      <Search key={query.get("query") ?? ""} {...props} />
      <label className="sort">
        <Icon name="sort" size={14} />
        <select
          aria-label="Sort"
          value={query.get("sort") ?? readSetting(SORT_SETTING) ?? "date"}
          onChange={(event) => {
            writeSetting(SORT_SETTING, event.target.value);
            chooser(props)("sort", event.target.value, "date");
          }}
        >
          {SORTS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
