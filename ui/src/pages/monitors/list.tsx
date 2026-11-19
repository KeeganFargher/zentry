// The monitor lists: All Monitors, My Monitors and one per type, as Sentry's
// views/detectors/list pages.

import type { ApiMe, ApiMonitor, CronUnrecognized } from "@contract";
import { useState } from "react";
import type { JSX } from "react";

import { Link, Notice } from "~/components/basics";
import { Icon } from "~/components/icons";
import { api } from "~/lib/api";
import { useNow } from "~/lib/clock";
import { useResource } from "~/lib/resource";
import type { Resource } from "~/lib/resource";
import { navigate, replaceQuery, useUrl } from "~/lib/router";
import type { MonitorListKind } from "~/lib/router";

import { BulkActions, PAGE_SIZE, Pagination } from "./list-controls";
import { MonitorRow } from "./list-row";
import { TopBar, useMonitorContext } from "./parts";
import type { MonitorContext } from "./parts";

const DAY = 24 * 60 * 60 * 1000;

const TITLES: Record<MonitorListKind, string> = {
  all: "Monitors",
  mine: "My Monitors",
  cron: "Cron Monitors",
  uptime: "Uptime Monitors",
  metric: "Metric Monitors",
};

function matches(monitor: ApiMonitor, kind: MonitorListKind, filters: Filters): boolean {
  const ofKind = kind === "all" || kind === "mine" || monitor.type === kind;
  const ofOwner = kind !== "mine" || monitor.ownerId === filters.me;
  const ofProject = filters.project === "" || String(monitor.projectId) === filters.project;
  const text = `${monitor.name} ${"slug" in monitor.config ? monitor.config.slug : ""} ${"url" in monitor.config ? monitor.config.url : ""}`;

  return ofKind && ofOwner && ofProject && text.toLowerCase().includes(filters.query.toLowerCase());
}

type Filters = { project: string; query: string; me: number };

/** Sentry's default sort: the monitor with the most recent issue first. */
function byLastIssue(a: ApiMonitor, b: ApiMonitor): number {
  return (
    (b.lastIssue?.lastSeen ?? 0) - (a.lastIssue?.lastSeen ?? 0) || a.name.localeCompare(b.name)
  );
}

function Toolbar(props: {
  kind: MonitorListKind;
  context: MonitorContext;
  org: string;
}): JSX.Element {
  const url = useUrl();
  const query = new URLSearchParams(url.search);

  const set = (key: string, value: string): void => {
    if (value === "") {
      query.delete(key);
    } else {
      query.set(key, value);
    }

    query.delete("page");
    replaceQuery(query);
  };

  const type = props.kind === "all" || props.kind === "mine" ? "" : `?type=${props.kind}`;

  return (
    <div className="monitor-toolbar">
      <select
        aria-label="Project"
        value={query.get("project") ?? ""}
        onChange={(event) => set("project", event.target.value)}
      >
        <option value="">All Projects</option>
        {props.context.projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </select>
      <label className="searchbox">
        <Icon name="search" />
        <input
          type="search"
          placeholder="Search for monitors"
          value={query.get("query") ?? ""}
          onChange={(event) => set("query", event.target.value)}
        />
      </label>
      <button
        type="button"
        className="primary"
        onClick={() => navigate(`/${props.org}/monitors/new/${type}`)}
      >
        <Icon name="add" size={14} /> Create Monitor
      </button>
    </div>
  );
}

function Unrecognized({ entries }: { entries: CronUnrecognized[] }): JSX.Element | null {
  if (entries.length === 0) {
    return null;
  }

  return (
    <div className="alert-banner warning">
      <Icon name="warning" />
      <div>
        <strong>Check-ins were received for slugs with no monitor.</strong>
        <ul>
          {entries.slice(0, 5).map((entry) => (
            <li key={`${entry.projectId}:${entry.slug}:${entry.environment}:${entry.reason}`}>
              <code>{entry.slug}</code> in {entry.environment}: {entry.count} check-ins (
              {entry.reason.replaceAll("_", " ")})
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

type TableProps = {
  org: string;
  monitors: ApiMonitor[];
  context: MonitorContext;
  timelines: boolean;
  reload: () => void;
};

type Selection = {
  selected: Set<string>;
  setSelected: (next: Set<string>) => void;
  toggle: (id: string, on: boolean) => void;
};

function useSelection(): Selection {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggle = (id: string, on: boolean): void => {
    const next = new Set(selected);

    if (on) {
      next.add(id);
    } else {
      next.delete(id);
    }

    setSelected(next);
  };

  return { selected, setSelected, toggle };
}

function ColumnTitles({ timelines }: { timelines: boolean }): JSX.Element {
  return (
    <>
      <span>Name</span>
      <span className="cell-type">Type</span>
      <span>Last Issue ↓</span>
      <span className="cell-assignee">Assignee</span>
      <span className="cell-alerts">Alerts</span>
      {timelines && <span className="muted small">Last 24 hours</span>}
    </>
  );
}

function MonitorTable({ org, monitors, context, timelines, reload }: TableProps): JSX.Element {
  const { selected, setSelected, toggle } = useSelection();
  const url = useUrl();
  const page = Number(url.searchParams.get("page") ?? "0");
  const shown = monitors.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const until = Math.ceil(useNow() / 60_000) * 60_000;
  const window = timelines ? { since: until - DAY, until } : null;
  const picked = monitors.filter(({ id }) => selected.has(id));
  const all = shown.length > 0 && shown.every(({ id }) => selected.has(id));

  if (monitors.length === 0) {
    return (
      <div className="panel empty-state">
        <strong>No monitors found.</strong>
        <span className="muted">Sorry, we couldn&apos;t find what you were looking for.</span>
      </div>
    );
  }

  return (
    <>
      <div
        className={timelines ? "panel monitor-table with-timeline" : "panel monitor-table"}
        role="table"
      >
        <div className="monitor-row head" role="row">
          <input
            type="checkbox"
            aria-label="Select all"
            checked={all}
            onChange={(event) =>
              setSelected(event.target.checked ? new Set(shown.map(({ id }) => id)) : new Set())
            }
          />
          {picked.length > 0 ? (
            <BulkActions
              org={org}
              selected={picked}
              clear={() => setSelected(new Set())}
              reload={reload}
            />
          ) : (
            <ColumnTitles timelines={timelines} />
          )}
        </div>
        {shown.map((monitor) => (
          <MonitorRow
            key={monitor.id}
            org={org}
            monitor={monitor}
            context={context}
            selected={selected.has(monitor.id)}
            onSelect={(on) => toggle(monitor.id, on)}
            window={window}
          />
        ))}
      </div>
      <Pagination page={page} total={monitors.length} />
    </>
  );
}

type ListData = { context: MonitorContext; monitors: ApiMonitor[]; me: ApiMe };

/** The list's three loads as one, so the page checks for absence once. */
function useListData(org: string): Resource<ListData> {
  const context = useMonitorContext(org);
  const monitors = useResource(`monitors:${org}`, () => api.monitors(org));
  const me = useResource("me", api.me);

  const data =
    context.data !== null && monitors.data !== null && me.data !== null
      ? { context: context.data, monitors: monitors.data, me: me.data }
      : null;

  return {
    data,
    loading: context.loading || monitors.loading || me.loading,
    error: context.error ?? monitors.error ?? me.error,
    reload: monitors.reload,
  };
}

type BodyProps = { org: string; kind: MonitorListKind; data: ListData; reload: () => void };

function ListBody({ org, kind, data, reload }: BodyProps): JSX.Element {
  const url = useUrl();

  const filters = {
    project: url.searchParams.get("project") ?? "",
    query: url.searchParams.get("query") ?? "",
    me: data.me.id,
  };

  return (
    <MonitorTable
      org={org}
      context={data.context}
      monitors={data.monitors
        .filter((monitor) => matches(monitor, kind, filters))
        .toSorted(byLastIssue)}
      timelines={kind === "cron" || kind === "uptime"}
      reload={reload}
    />
  );
}

export function MonitorList({ org, kind }: { org: string; kind: MonitorListKind }): JSX.Element {
  const list = useListData(org);
  const unrecognized = useResource(`unrecognized:${org}`, () => api.unrecognizedCheckIns(org));
  const data = list.data;

  return (
    <>
      <TopBar crumbs={[{ label: TITLES[kind] }]} />
      <div className="content monitor-page">
        {data !== null && <Toolbar kind={kind} context={data.context} org={org} />}
        {kind === "cron" && <Unrecognized entries={unrecognized.data ?? []} />}
        {data === null ? (
          <Notice loading={list.loading} error={list.error} onRetry={list.reload} />
        ) : (
          <ListBody org={org} kind={kind} data={data} reload={list.reload} />
        )}
        <p className="muted small">
          Monitors open issues when what they watch goes wrong. Route them to people with{" "}
          <Link to={`/${org}/monitors/alerts/`}>alerts</Link>.
        </p>
      </div>
    </>
  );
}
