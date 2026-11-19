import type { ApiMonitor, ApiMonitorRule, ApiProject, MonitorMember } from "@contract";
import { useState } from "react";
import type { JSX } from "react";

import { Link, Notice } from "~/components/basics";
import { api } from "~/lib/api";
import { useResource } from "~/lib/resource";
import { navigate } from "~/lib/router";

import { MonitorControls } from "./monitor-control";
import { MonitorForm } from "./monitor-form";
import { HEALTH, MonitorAudit, MonitorOperations, MonitorTimeline } from "./monitor-history";
import { MonitorRuleForm } from "./monitor-rule-form";

const LABELS = { metric: "Metric", cron: "Cron", uptime: "Uptime" };

function MonitorHealth({ monitor }: { monitor: ApiMonitor }): JSX.Element {
  return (
    <span className="monitor-health" data-health={monitor.health}>
      {monitor.status === "active" ? HEALTH[monitor.health] : monitor.status}
    </span>
  );
}

type RuleProps = {
  org: string;
  rules: ApiMonitorRule[];
  members: MonitorMember[];
  reload: () => void;
};

function Rules({ org, rules, members, reload }: RuleProps): JSX.Element {
  const [selected, setSelected] = useState("");
  const current = rules.find(({ id }) => id === selected);

  return (
    <details className="panel padded">
      <summary>Manage alert rules</summary>
      <label>
        Alert rule
        <select value={selected} onChange={(event) => setSelected(event.currentTarget.value)}>
          <option value="">New alert rule</option>
          {rules.map(({ id, name }) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <MonitorRuleForm
        key={current === undefined ? "new" : `${current.id}:${current.version}`}
        members={members}
        {...(current === undefined ? {} : { rule: current })}
        save={async (body) => {
          const rule =
            current === undefined
              ? await api.createMonitorRule(org, body)
              : await api.editMonitorRule(org, current, body);

          setSelected(rule.id);
          reload();
        }}
      />
    </details>
  );
}

type ListProps = {
  org: string;
  monitors: ApiMonitor[];
  projects: ApiProject[];
  members: MonitorMember[];
};

type Filters = { project: string; type: string; health: string; owner: string };

function matches(monitor: ApiMonitor, filters: Filters): boolean {
  return (
    (filters.project === "" || String(monitor.projectId) === filters.project) &&
    (filters.type === "" || monitor.type === filters.type) &&
    (filters.health === "" || monitor.health === filters.health) &&
    (filters.owner === "" || String(monitor.ownerId ?? "") === filters.owner)
  );
}

function MonitorFilters({
  filters,
  set,
  projects,
  members,
}: Pick<ListProps, "projects" | "members"> & {
  filters: Filters;
  set: (filter: Filters) => void;
}): JSX.Element {
  return (
    <div className="form-row">
      <label>
        Filter by project{" "}
        <select
          value={filters.project}
          onChange={(event) => set({ ...filters, project: event.currentTarget.value })}
        >
          <option value="">All projects</option>
          {projects.map(({ id, name }) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Filter by type{" "}
        <select
          value={filters.type}
          onChange={(event) => set({ ...filters, type: event.currentTarget.value })}
        >
          <option value="">All types</option>
          {Object.entries(LABELS).map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Filter by health{" "}
        <select
          value={filters.health}
          onChange={(event) => set({ ...filters, health: event.currentTarget.value })}
        >
          <option value="">All states</option>
          {Object.entries(HEALTH).map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
      </label>
      <OwnerFilter filters={filters} set={set} members={members} />
    </div>
  );
}

function MonitorList({ org, monitors, projects, members }: ListProps): JSX.Element {
  const [filters, set] = useState<Filters>({ project: "", type: "", health: "", owner: "" });
  const filtered = monitors.filter((monitor) => matches(monitor, filters));

  return (
    <>
      <MonitorFilters filters={filters} set={set} projects={projects} members={members} />
      <div className="panel monitor-list">
        {filtered.length === 0 && <p className="padded muted">No monitors match these filters.</p>}
        {filtered.map((monitor) => (
          <Link to={`/${org}/monitors/${monitor.id}/`} key={monitor.id} className="monitor-row">
            <div>
              <strong>{monitor.name}</strong>
              <span className="muted">
                {projects.find(({ id }) => id === monitor.projectId)?.name}
                {monitor.evaluatedAt !== null &&
                  ` · ${new Date(monitor.evaluatedAt).toLocaleString()}`}
              </span>
            </div>
            <span>{LABELS[monitor.type]}</span>
            <MonitorHealth monitor={monitor} />
          </Link>
        ))}
      </div>
    </>
  );
}

function useMonitorOptions(org: string) {
  return {
    projects: useResource(`projects:${org}`, () => api.projects(org)).data ?? [],
    members: useResource(`monitor-members:${org}`, () => api.monitorMembers(org)).data ?? [],
    rules: useResource(`monitor-rules:${org}`, () => api.monitorRules(org)),
  };
}

function Monitors({ org }: { org: string }): JSX.Element {
  const { projects, members, rules } = useMonitorOptions(org);
  const list = useResource(`monitors:${org}`, () => api.monitors(org));
  const routes = rules.data ?? [];

  return (
    <>
      <header className="topbar">
        <h1>Monitors</h1>
      </header>
      <div className="content monitor-content">
        <Notice
          loading={list.loading}
          error={list.error}
          empty={list.data?.length === 0 ? "No monitors configured." : null}
        />
        {list.data !== null && list.data.length > 0 && (
          <>
            <MonitorOperations monitors={list.data} />
            <MonitorList org={org} monitors={list.data} projects={projects} members={members} />
          </>
        )}
        <Rules org={org} rules={routes} members={members} reload={rules.reload} />
        {projects.length > 0 && (
          <MonitorForm
            preview={(body) => api.previewMonitor(org, body)}
            projects={projects}
            rules={routes}
            members={members}
            save={async (body) => {
              const monitor = await api.createMonitor(org, body);

              navigate(`/${org}/monitors/${monitor.id}/`);
            }}
          />
        )}
      </div>
    </>
  );
}

function MonitorPage({ org, id }: { org: string; id: string }): JSX.Element {
  const resource = useResource(`monitor:${org}:${id}`, () => api.monitor(org, id));
  const { projects, members, rules } = useMonitorOptions(org);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const detail = resource.data;

  if (detail === null) {
    return <Notice loading={resource.loading} error={resource.error} empty={null} />;
  }

  const { monitor } = detail;

  const run = async (action: () => Promise<ApiMonitor>): Promise<void> => {
    setError("");

    try {
      await action();
      resource.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update monitor");
    }
  };

  return (
    <>
      <header className="topbar">
        <h1>{monitor.name}</h1>
        <MonitorHealth monitor={monitor} />
      </header>
      <div className="content monitor-content">
        <Link to={`/${org}/monitors/`}>All monitors</Link>
        {error !== "" && <p role="alert">{error}</p>}
        <MonitorControls
          detail={detail}
          org={org}
          editing={editing}
          edit={() => setEditing(!editing)}
          update={(status) => run(() => api.setMonitorStatus(org, monitor, status))}
          mute={(until) => run(() => api.muteMonitor(org, monitor, { until }))}
        />
        {editing && monitor.status !== "archived" && (
          <MonitorForm
            initial={monitor}
            preview={(body) => api.previewMonitor(org, body)}
            projects={projects}
            members={members}
            rules={rules.data ?? []}
            save={async (body) => {
              await api.editMonitor(org, monitor, body);
              setEditing(false);
              resource.reload();
            }}
          />
        )}
        <MonitorTimeline
          key={`${id}:${monitor.version}:${detail.observations[0]?.id ?? 0}`}
          detail={detail}
          org={org}
        />
        <MonitorAudit detail={detail} org={org} />
      </div>
    </>
  );
}

export function MonitorsRoute({
  route,
}: {
  route: { org: string; id: string | undefined };
}): JSX.Element {
  return route.id === undefined ? (
    <Monitors org={route.org} />
  ) : (
    <MonitorPage org={route.org} id={route.id} />
  );
}

function OwnerFilter({
  filters,
  set,
  members,
}: {
  filters: Filters;
  set: (filter: Filters) => void;
  members: MonitorMember[];
}): JSX.Element {
  return (
    <label>
      Filter by owner{" "}
      <select
        value={filters.owner}
        onChange={(event) => set({ ...filters, owner: event.currentTarget.value })}
      >
        <option value="">All owners</option>
        {members.map(({ userId, email }) => (
          <option key={userId} value={userId}>
            {email}
          </option>
        ))}
      </select>
    </label>
  );
}
