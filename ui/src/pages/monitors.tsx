import type { ApiMonitor, MonitorDetail } from "@contract";
import { useState } from "react";
import type { JSX } from "react";

import { Link, Notice } from "~/components/basics";
import { api } from "~/lib/api";
import { useResource } from "~/lib/resource";
import { navigate } from "~/lib/router";

import { MonitorForm } from "./monitor-form";

const LABELS = { metric: "Metric", cron: "Cron", uptime: "Uptime" };

const HEALTH = {
  awaiting_data: "Awaiting data",
  healthy: "Healthy",
  degraded: "Degraded",
  failing: "Failing",
  unknown: "Unknown",
};

function MonitorHealth({ monitor }: { monitor: ApiMonitor }): JSX.Element {
  return (
    <span className="monitor-health" data-health={monitor.health}>
      {monitor.status === "active" ? HEALTH[monitor.health] : monitor.status}
    </span>
  );
}

function Monitors({ org }: { org: string }): JSX.Element {
  const projects = useResource(`projects:${org}`, () => api.projects(org));
  const monitors = useResource(`monitors:${org}`, () => api.monitors(org));
  const list = monitors.data ?? [];

  return (
    <>
      <header className="topbar">
        <h1>Monitors</h1>
      </header>
      <div className="content monitor-content">
        <Notice
          loading={monitors.loading}
          error={monitors.error}
          empty={list.length === 0 ? "No monitors configured." : null}
        />
        {list.length > 0 && (
          <div className="panel monitor-list">
            {list.map((monitor) => (
              <Link to={`/${org}/monitors/${monitor.id}/`} key={monitor.id} className="monitor-row">
                <div>
                  <strong>{monitor.name}</strong>
                  <span className="muted">
                    {projects.data?.find(({ id }) => id === monitor.projectId)?.name}
                  </span>
                </div>
                <span>{LABELS[monitor.type]}</span>
                <MonitorHealth monitor={monitor} />
              </Link>
            ))}
          </div>
        )}
        {projects.data !== null && projects.data.length > 0 && (
          <MonitorForm
            preview={(body) => api.previewMonitor(org, body)}
            projects={projects.data}
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

function Activity({ detail, org }: { detail: MonitorDetail; org: string }): JSX.Element {
  return (
    <section className="panel padded">
      <h2>Recent observations</h2>
      {detail.monitor.issueId !== null && (
        <Link to={`/${org}/issues/${detail.monitor.issueId}/`}>View monitor issue</Link>
      )}
      {detail.observations.length === 0 && (
        <p className="muted">Waiting for the first observation.</p>
      )}
      <ol className="monitor-observations">
        {detail.observations.map(({ id, time, health, evidence }) => (
          <li key={id}>
            <time dateTime={new Date(time).toISOString()}>{new Date(time).toLocaleString()}</time>
            <span>{HEALTH[health]}</span>
            <code>{JSON.stringify(evidence)}</code>
          </li>
        ))}
      </ol>
    </section>
  );
}

function MonitorPage({ org, id }: { org: string; id: string }): JSX.Element {
  const data = useResource(`monitor:${org}:${id}`, () => api.monitor(org, id));
  const projects = useResource(`projects:${org}`, () => api.projects(org));
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);

  if (data.data === null) {
    return <Notice loading={data.loading} error={data.error} empty={null} />;
  }

  const detail = data.data;
  const { monitor } = detail;

  const update = async (status: ApiMonitor["status"]): Promise<void> => {
    setError("");

    try {
      await api.setMonitorStatus(org, monitor, status);
      data.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update monitor");
    }
  };

  const settings = (
    <>
      {" "}
      {editing && projects.data !== null && monitor.status !== "archived" && (
        <MonitorForm
          preview={(body) => api.previewMonitor(org, body)}
          initial={monitor}
          projects={projects.data}
          save={async (body) => {
            await api.editMonitor(org, monitor, body);
            setEditing(false);
            data.reload();
          }}
        />
      )}
    </>
  );

  return (
    <MonitorDetailsView
      detail={detail}
      org={org}
      error={error}
      editing={editing}
      update={update}
      setEditing={setEditing}
      settings={settings}
    />
  );
}

type MonitorDetailsViewProps = {
  detail: MonitorDetail;
  org: string;
  error: string;
  editing: boolean;
  update: (status: ApiMonitor["status"]) => Promise<void>;
  setEditing: (editing: boolean) => void;
  settings: JSX.Element;
};

function SignalSummary({ monitor }: { monitor: ApiMonitor }): JSX.Element {
  return (
    <>
      {" "}
      {monitor.type === "cron" && (
        <p>
          Send SDK check-ins for <code>{monitor.config.slug}</code> in{" "}
          <code>{monitor.config.environment}</code>.
        </p>
      )}
      {monitor.type === "uptime" && (
        <p>
          <code>
            {monitor.config.method} {monitor.config.url}
          </code>
        </p>
      )}
      {monitor.type === "metric" && (
        <p>
          Open an issue at {monitor.config.threshold} errors within{" "}
          {monitor.config.windowSeconds / 60} minutes.
        </p>
      )}
    </>
  );
}

function MonitorDetailsView({
  detail,
  org,
  error,
  editing,
  update,
  setEditing,
  settings,
}: MonitorDetailsViewProps): JSX.Element {
  const { monitor } = detail;
  const paused = monitor.status === "paused";

  return (
    <>
      <header className="topbar">
        <h1>{monitor.name}</h1>
        <MonitorHealth monitor={monitor} />
      </header>
      <div className="content monitor-content">
        <Link to={`/${org}/monitors/`}>All monitors</Link>
        <section className="panel padded">
          <h2>{LABELS[monitor.type]} monitor</h2>
          <SignalSummary monitor={monitor} />
          {monitor.status !== "archived" && (
            <div className="form-row">
              <button type="button" onClick={() => void update(paused ? "active" : "paused")}>
                {paused ? "Resume monitor" : "Pause monitor"}
              </button>
              <button type="button" onClick={() => setEditing(!editing)}>
                {editing ? "Close settings" : "Edit monitor"}
              </button>
              {paused && (
                <button type="button" onClick={() => void update("archived")}>
                  Archive monitor
                </button>
              )}
            </div>
          )}
          {error !== "" && <p role="alert">{error}</p>}
        </section>
        {settings}
        <Activity detail={detail} org={org} />
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
