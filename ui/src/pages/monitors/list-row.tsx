// One row of the monitor table, as Sentry's DetectorListRow: name with a
// details line, type, last issue, assignee, alerts, and for cron and uptime
// lists a timeline of the last day.

import type { ApiMonitor, MonitorTimeline } from "@contract";
import type { JSX } from "react";

import { Ago, Link } from "~/components/basics";
import { TimelineRow } from "~/components/check-in-timeline";
import { Clipped } from "~/components/tooltip";
import { api } from "~/lib/api";
import {
  COMPARATOR_SIGNS,
  everyMinutes,
  pluralize,
  scheduleText,
  TYPE_LABELS,
} from "~/lib/monitor-text";
import { useResource } from "~/lib/resource";

import { memberEmail, ProjectBadge, projectOf } from "./parts";
import type { MonitorContext } from "./parts";

/** The items after the project on the details line. */
function details(monitor: ApiMonitor): string[] {
  if (monitor.type === "cron") {
    return [scheduleText(monitor.config.schedule)];
  }

  if (monitor.type === "uptime") {
    return [monitor.config.url, everyMinutes(monitor.config.intervalMinutes)];
  }

  const { comparator, threshold, windowSeconds, environment } = monitor.config;
  const sign = COMPARATOR_SIGNS[comparator];

  return [
    environment ?? "All environments",
    `count() over ${windowSeconds / 60}m`,
    `${sign}${threshold} high`,
  ];
}

function NameCell({ org, monitor, context }: RowProps): JSX.Element {
  return (
    <div className="monitor-name">
      <div>
        <Link to={`/${org}/monitors/${monitor.id}/`}>
          <strong>{monitor.name}</strong>
        </Link>
        {monitor.status === "paused" && <span className="muted"> — Disabled</span>}
      </div>
      <div className="monitor-details muted">
        <ProjectBadge project={projectOf(context.projects, monitor)} />
        {details(monitor).map((item) => (
          <span key={item} className="detail-item">
            <Clipped text={item} />
          </span>
        ))}
      </div>
    </div>
  );
}

function LastIssueCell({ org, monitor }: Pick<RowProps, "org" | "monitor">): JSX.Element {
  const issue = monitor.lastIssue;

  if (issue === null) {
    return <span className="muted">—</span>;
  }

  return (
    <div className="last-issue">
      <Link to={`/${org}/issues/${issue.id}/`}>
        <Clipped text={issue.title} />
      </Link>
      <span className="muted small">
        Last seen <Ago at={issue.lastSeen} label="Last seen" />
      </span>
    </div>
  );
}

type RowProps = {
  org: string;
  monitor: ApiMonitor;
  context: MonitorContext;
  selected: boolean;
  onSelect: (selected: boolean) => void;
  window: Pick<MonitorTimeline, "since" | "until"> | null;
};

function RowTimeline({
  org,
  monitor,
  window,
}: Pick<RowProps, "org" | "monitor"> & {
  window: Pick<MonitorTimeline, "since" | "until">;
}): JSX.Element {
  const timeline = useResource(`timeline:${monitor.id}:${window.since}`, () =>
    api.monitorTimeline(org, monitor.id, { ...window, buckets: 96 }),
  );

  const data = timeline.data;

  if (data === null) {
    return timeline.error === null ? (
      <div className="tick-row placeholder" />
    ) : (
      <span className="muted small">
        Timeline failed to load: {timeline.error}{" "}
        <button type="button" className="plain small" onClick={timeline.reload}>
          Retry
        </button>
      </span>
    );
  }

  const scopes = [...new Set(data.buckets.map(({ scope }) => scope))].toSorted();

  return (
    <div className="row-timelines">
      {(scopes.length === 0 ? [""] : scopes).map((scope) => (
        <div key={scope} className="row-timeline">
          {monitor.type === "cron" && <span className="env-label muted small">{scope || "—"}</span>}
          <TimelineRow timeline={data} scope={scope} />
        </div>
      ))}
    </div>
  );
}

export function MonitorRow(props: RowProps): JSX.Element {
  const { org, monitor, context, selected, onSelect, window } = props;
  const assignee = monitor.ownerId === null ? null : memberEmail(context.members, monitor.ownerId);
  const alerts = monitor.alertRuleIds.length;

  return (
    <div className={monitor.status === "paused" ? "monitor-row faded" : "monitor-row"}>
      <input
        type="checkbox"
        aria-label={`Select ${monitor.name}`}
        checked={selected}
        onChange={(event) => onSelect(event.target.checked)}
      />
      <NameCell {...props} />
      <span className="cell-type">{TYPE_LABELS[monitor.type]}</span>
      <LastIssueCell org={org} monitor={monitor} />
      <span className="cell-assignee">
        {assignee === null ? <span className="muted">—</span> : <Clipped text={assignee} />}
      </span>
      <span className="cell-alerts">
        {alerts === 0 ? <span className="muted">—</span> : pluralize(alerts, "1 alert", "alerts")}
      </span>
      {window !== null && <RowTimeline org={org} monitor={monitor} window={window} />}
    </div>
  );
}
