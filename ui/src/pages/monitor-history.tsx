import type { ApiMonitor, MonitorCoverage, MonitorDetail, MonitorHistory } from "@contract";
import { useState } from "react";
import type { JSX } from "react";

import { Link } from "~/components/basics";
import { api } from "~/lib/api";

export const HEALTH: Record<ApiMonitor["health"], string> = {
  awaiting_data: "Awaiting data",
  healthy: "Healthy",
  degraded: "Degraded",
  failing: "Failing",
  unknown: "Unknown",
};

export function Coverage({ coverage }: { coverage: MonitorCoverage }): JSX.Element {
  const observed = coverage.successful + coverage.failed;
  const scheduled = observed + coverage.unknown;
  const completeness = scheduled === 0 ? 0 : observed / scheduled;

  const uptime =
    observed === 0 || completeness < 0.95
      ? "Insufficient coverage"
      : (coverage.successful / observed).toLocaleString(undefined, {
          style: "percent",
          maximumFractionDigits: 1,
        });

  return (
    <p>
      {uptime} observed uptime · {observed} of {scheduled} checks observed · {coverage.unknown}{" "}
      unknown in the past 24 hours
    </p>
  );
}

export function MonitorTimeline({
  detail,
  org,
}: {
  detail: MonitorDetail;
  org: string;
}): JSX.Element {
  const [more, setMore] = useState<MonitorHistory>({
    observations: [],
    nextCursor: detail.nextCursor,
  });

  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const observations = [...detail.observations, ...more.observations];

  const loadMore = async (cursor: string): Promise<void> => {
    setBusy(true);
    setError("");

    try {
      const page = await api.monitorHistory(org, detail.monitor.id, cursor);
      setMore((previous) => ({
        observations: [...previous.observations, ...page.observations],
        nextCursor: page.nextCursor,
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load observations");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel padded">
      <h2>Observations</h2>
      {observations.length === 0 && <p className="muted">Waiting for the first observation.</p>}
      <ol className="monitor-observations">
        {observations.map(({ id, time, health, scope, evidence, severity }) => (
          <li key={id}>
            <time dateTime={new Date(time).toISOString()}>{new Date(time).toLocaleString()}</time>
            <span>
              {scope === "" ? "" : `${scope} · `}
              {HEALTH[health]} {severity}
            </span>
            <code>{JSON.stringify(evidence)}</code>
          </li>
        ))}
      </ol>
      {more.nextCursor !== null && (
        <button type="button" disabled={busy} onClick={() => void loadMore(more.nextCursor ?? "")}>
          Older observations
        </button>
      )}
      {error !== "" && <p role="alert">{error}</p>}
    </section>
  );
}

export function MonitorDeliveries({ detail }: { detail: MonitorDetail }): JSX.Element {
  return (
    <section className="panel padded">
      <h2>Alert deliveries</h2>
      {detail.deliveries.length === 0 && <p className="muted">No alert deliveries recorded.</p>}
      <ul>
        {detail.deliveries.map(({ id, transition, channel, time, suppression }) => (
          <li key={id}>
            {new Date(time).toLocaleString()} · {transition} · {channel} ·{" "}
            {suppression?.replaceAll("_", " ") ?? "Routed"}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function CronCheckIns({ detail }: { detail: MonitorDetail }): JSX.Element {
  return (
    <section className="panel padded">
      <h2>SDK check-ins</h2>
      {detail.checkIns.length === 0 && <p className="muted">Waiting for the first check-in.</p>}
      <ul>
        {detail.checkIns.map(({ runId, status, environment, receivedAt, slot, durationMs }) => (
          <li key={`${environment}:${runId}:${status}`}>
            {new Date(receivedAt).toLocaleString()} · {environment} · {status} ·{" "}
            {slot === null ? "Unscheduled" : new Date(slot).toLocaleString()}
            {durationMs === null ? "" : ` · ${durationMs} ms`}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function MonitorAudit({ detail, org }: { detail: MonitorDetail; org: string }): JSX.Element {
  return (
    <>
      <section className="panel padded">
        <h2>Incident periods</h2>
        {detail.incidents.length === 0 && <p className="muted">No incidents recorded.</p>}
        <ul>
          {detail.incidents.map((incident) => (
            <li key={`${incident.issueId}:${incident.openedAt}`}>
              <Link to={`/${org}/issues/${incident.issueId}/`}>
                {incident.scope === "" ? "Issue" : incident.scope}
              </Link>
              {" · "}
              {new Date(incident.openedAt).toLocaleString()} ·{" "}
              {incident.disposition?.replaceAll("_", " ") ?? "Open"}
            </li>
          ))}
        </ul>
      </section>
      <MonitorDeliveries detail={detail} />
      {detail.monitor.type === "cron" && <CronCheckIns detail={detail} />}
      <section className="panel padded">
        <h2>Configuration audit</h2>
        {detail.audit.map(({ version, time, actorId, snapshot }) => (
          <details key={version}>
            <summary>
              Revision {version} · {new Date(time).toLocaleString()} ·{" "}
              {actorId === null ? "System" : `Member ${actorId}`}
            </summary>
            <pre>{JSON.stringify(snapshot, null, 2)}</pre>
          </details>
        ))}
      </section>
    </>
  );
}

export function MonitorOperations({ monitors }: { monitors: ApiMonitor[] }): JSX.Element {
  const active = monitors.filter(({ status }) => status === "active");
  const unknown = active.filter(({ health }) => health === "unknown").length;
  const waiting = active.filter(({ health }) => health === "awaiting_data").length;
  const incidents = active.filter(({ health }) => health === "failing").length;
  const paused = monitors.filter(({ status }) => status === "paused").length;
  const last = Math.max(0, ...active.map(({ evaluatedAt }) => evaluatedAt ?? 0));

  return (
    <details className="panel padded">
      <summary>Monitoring operations</summary>
      <dl>
        <dt>Active monitors</dt>
        <dd>{active.length}</dd>
        <dt>Failing</dt>
        <dd>{incidents}</dd>
        <dt>Unknown coverage</dt>
        <dd>{unknown}</dd>
        <dt>Awaiting data</dt>
        <dd>{waiting}</dd>
        <dt>Paused</dt>
        <dd>{paused}</dd>
        <dt>Last recorded evaluation</dt>
        <dd>{last > 0 ? new Date(last).toLocaleString() : "Awaiting evaluation"}</dd>
      </dl>
    </details>
  );
}
