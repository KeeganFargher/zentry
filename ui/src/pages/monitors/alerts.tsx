// The Alerts list, as Sentry's automations list under Monitors.

import type { ApiMonitor, ApiMonitorRule, ApiProject } from "@contract";
import type { JSX } from "react";

import { Ago, Link, Notice, Platform } from "~/components/basics";
import { Icon } from "~/components/icons";
import { api } from "~/lib/api";
import { pluralize } from "~/lib/monitor-text";
import { useResource } from "~/lib/resource";
import { navigate, replaceQuery, useUrl } from "~/lib/router";

import { TopBar, useMonitorContext } from "./parts";
import type { MonitorContext } from "./parts";

const CHANNELS = { email: "Email", push: "Mobile push" };

function linkedTo(rule: ApiMonitorRule, monitors: ApiMonitor[]): ApiMonitor[] {
  return monitors.filter(({ alertRuleIds }) => alertRuleIds.includes(rule.id));
}

function RuleRow({
  org,
  rule,
  monitors,
  context,
}: {
  org: string;
  rule: ApiMonitorRule;
  monitors: ApiMonitor[];
  context: MonitorContext;
}): JSX.Element {
  const linked = linkedTo(rule, monitors);

  const projects = [...new Set(linked.map(({ projectId }) => projectId))].flatMap((id) =>
    context.projects.filter((project) => project.id === id),
  );

  return (
    <div className="rule-row">
      <span>
        <Link to={`/${org}/monitors/alerts/${rule.id}/`}>
          <strong>{rule.name}</strong>
        </Link>
        {!rule.enabled && <span className="muted"> — Disabled</span>}
      </span>
      <span>
        {rule.lastTriggered === null ? (
          <span className="muted">—</span>
        ) : (
          <Ago at={rule.lastTriggered} label="Last triggered" />
        )}
      </span>
      <span>
        <Icon name="mail" size={14} />{" "}
        {rule.channels.map((channel) => CHANNELS[channel]).join(", ")}
      </span>
      <span className="rule-projects">
        {projects.length === 0 ? (
          <span className="muted">—</span>
        ) : (
          projects.map((project) => <Platform key={project.id} name={project.platform} />)
        )}
      </span>
      <span>
        {linked.length === 0 ? (
          <span className="muted">—</span>
        ) : (
          pluralize(linked.length, "1 monitor", "monitors")
        )}
      </span>
    </div>
  );
}

/** Sets or clears one search parameter, keeping the others. */
function setQuery(key: string, value: string): void {
  const query = new URLSearchParams(window.location.search);

  if (value === "") {
    query.delete(key);
  } else {
    query.set(key, value);
  }

  replaceQuery(query);
}

function AlertToolbar({
  org,
  project,
  search,
  projects,
}: {
  org: string;
  project: string;
  search: string;
  projects: ApiProject[];
}): JSX.Element {
  return (
    <div className="monitor-toolbar">
      <select
        aria-label="Project"
        value={project}
        onChange={(event) => setQuery("project", event.target.value)}
      >
        <option value="">All Projects</option>
        {projects.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {entry.name}
          </option>
        ))}
      </select>
      <label className="searchbox">
        <Icon name="search" />
        <input
          type="search"
          aria-label="Search for alerts"
          placeholder="Search for alerts"
          value={search}
          onChange={(event) => setQuery("query", event.target.value)}
        />
      </label>
      <button
        type="button"
        className="primary"
        onClick={() => navigate(`/${org}/monitors/alerts/new/`)}
      >
        <Icon name="add" size={14} /> Create Alert
      </button>
    </div>
  );
}

type TableProps = {
  org: string;
  search: string;
  project: string;
  monitors: ApiMonitor[];
  context: MonitorContext;
};

/** Rules matching the search and project, most recently triggered first, as Sentry's default sort. */
function RuleTable({ org, search, project, monitors, context }: TableProps): JSX.Element {
  const rules = context.rules
    .filter(({ name }) => name.toLowerCase().includes(search.toLowerCase()))
    .filter(
      (rule) =>
        project === "" ||
        linkedTo(rule, monitors).some(({ projectId }) => String(projectId) === project),
    )
    .toSorted((a, b) => (b.lastTriggered ?? 0) - (a.lastTriggered ?? 0));

  if (rules.length === 0) {
    return (
      <div className="panel empty-state">
        <strong>No alerts found.</strong>
        <span className="muted">
          Alerts decide who hears about a monitor&apos;s issues, and how.
        </span>
      </div>
    );
  }

  return (
    <div className="panel rule-table">
      <div className="rule-row head">
        <span>Name</span>
        <span>Last Triggered ↓</span>
        <span>Actions</span>
        <span>Projects</span>
        <span>Monitors</span>
      </div>
      {rules.map((rule) => (
        <RuleRow key={rule.id} org={org} rule={rule} monitors={monitors} context={context} />
      ))}
    </div>
  );
}

export function AlertList({ org }: { org: string }): JSX.Element {
  const url = useUrl();
  const context = useMonitorContext(org);
  const monitors = useResource(`monitors:${org}`, () => api.monitors(org));
  const search = url.searchParams.get("query") ?? "";
  const project = url.searchParams.get("project") ?? "";
  const data = context.data;

  return (
    <>
      <TopBar crumbs={[{ label: "Alerts" }]} />
      <div className="content monitor-page">
        <AlertToolbar org={org} project={project} search={search} projects={data?.projects ?? []} />
        {data !== null && monitors.data !== null ? (
          <RuleTable
            org={org}
            search={search}
            project={project}
            monitors={monitors.data}
            context={data}
          />
        ) : (
          <Notice
            loading={context.loading || monitors.loading}
            error={context.error ?? monitors.error}
          />
        )}
      </div>
    </>
  );
}
