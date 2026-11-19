// The detail page's right column, as Sentry's cron, uptime and metric detail
// sidebars: Detect, Resolve, Assign, Schedule, Legend, Description, Details.

import type { ApiMonitor, MonitorDetail as Detail, TimelineStatus } from "@contract";
import type { JSX, ReactNode } from "react";

import { TimeSince } from "~/components/basics";
import { StatusSwatch } from "~/components/check-in-timeline";
import { CopyButton } from "~/components/overlays";
import { dateTime } from "~/lib/format";
import { everyMinutes, pluralize, scheduleText } from "~/lib/monitor-text";

import { memberEmail, PriorityDot } from "./parts";
import type { MonitorContext } from "./parts";

function Block({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <section className="side-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function Detect({ monitor }: { monitor: ApiMonitor }): JSX.Element {
  if (monitor.type === "cron") {
    return (
      <p>
        {pluralize(
          monitor.config.failureThreshold,
          "One failed check-in.",
          "consecutive failed check-ins.",
        )}
      </p>
    );
  }

  if (monitor.type === "uptime") {
    return (
      <>
        <p>
          {pluralize(
            monitor.config.failureThreshold,
            "One failed check.",
            "consecutive failed checks.",
          )}
        </p>
        <code className="code-line">
          {monitor.config.method} {monitor.config.url}
        </code>
      </>
    );
  }

  const { comparator, threshold, warningThreshold, windowSeconds, level, environment } =
    monitor.config;

  const direction = comparator.startsWith("gt") ? "Above" : "Below";
  const inclusive = comparator.endsWith("e") ? " or equal to" : "";

  return (
    <dl className="detect-list">
      <dt>Dataset:</dt>
      <dd>Errors{level === undefined ? "" : ` (level ${level})`}</dd>
      <dt>Query:</dt>
      <dd>count(){environment === undefined ? "" : ` in ${environment}`}</dd>
      <dt>Interval:</dt>
      <dd>{windowSeconds / 60} minutes</dd>
      <dt>Threshold:</dt>
      <dd>
        <div>
          <PriorityDot priority="high" /> High: {direction}
          {inclusive} {threshold}
        </div>
        {warningThreshold !== undefined && (
          <div>
            <PriorityDot priority="medium" /> Medium: {direction}
            {inclusive} {warningThreshold}
          </div>
        )}
      </dd>
    </dl>
  );
}

function resolveText(monitor: ApiMonitor): string {
  if (monitor.type === "cron") {
    return pluralize(
      monitor.config.recoveryThreshold,
      "One successful check-in.",
      "consecutive successful check-ins.",
    );
  }

  if (monitor.type === "uptime") {
    return pluralize(
      monitor.config.recoveryThreshold,
      "One successful check.",
      "consecutive successful checks.",
    );
  }

  const { recoveryThreshold, warningThreshold, threshold, comparator } = monitor.config;
  const at = recoveryThreshold ?? warningThreshold ?? threshold;

  return `Resolved when the count is ${comparator.startsWith("gt") ? "at or below" : "at or above"} ${at}.`;
}

const LEGEND: Record<ApiMonitor["type"], [TimelineStatus, (monitor: ApiMonitor) => string][]> = {
  cron: [
    [
      "missed",
      (monitor) =>
        `Check-in missed after ${monitor.type === "cron" ? monitor.config.graceMinutes : 1} min`,
    ],
    ["error", () => "Check-in reported as failed"],
    [
      "timeout",
      (monitor) =>
        `Check-in timed out after ${monitor.type === "cron" ? monitor.config.maxRuntimeMinutes : 30} min`,
    ],
  ],
  uptime: [
    ["success", () => "Uptime"],
    ["failure", () => "Failure"],
    ["downtime", () => "Downtime"],
    ["unknown", () => "Unknown"],
  ],
  metric: [
    ["high", () => "High priority"],
    ["medium", () => "Medium priority"],
    ["ok", () => "Resolved"],
  ],
};

type DetailRow = [label: string, value: ReactNode];

type CronMonitor = Extract<ApiMonitor, { type: "cron" }>;

/** The slug and the soonest next / latest last check-in across environments. */
function cronRows(monitor: CronMonitor, detail: Detail): DetailRow[] {
  const next = detail.scopes
    .map(({ nextAt }) => nextAt)
    .filter((at) => at !== null)
    .toSorted((a, b) => a - b)[0];

  const last = detail.scopes
    .map(({ lastCheckIn }) => lastCheckIn)
    .filter((at) => at !== null)
    .toSorted((a, b) => a - b)
    .at(-1);

  return [
    [
      "Monitor slug",
      <span key="slug" className="slug">
        {monitor.config.slug}{" "}
        <CopyButton text={monitor.config.slug} message="Copied the monitor slug" />
      </span>,
    ],
    ["Next check-in", next === undefined || monitor.status !== "active" ? "-" : dateTime(next)],
    [
      "Last check-in",
      last === undefined ? "-" : <TimeSince key="last" at={last} label="Last check-in" />,
    ],
  ];
}

/** The rows only one type has: cron's schedule state, uptime's interval and timeout. */
function typeRows(detail: Detail): DetailRow[] {
  const { monitor } = detail;

  if (monitor.type === "cron") {
    return cronRows(monitor, detail);
  }

  const environment: DetailRow = ["Environment", monitor.config.environment ?? "All environments"];

  if (monitor.type === "uptime") {
    return [
      ["Interval", everyMinutes(monitor.config.intervalMinutes)],
      ["Timeout", `After ${monitor.config.timeoutMs / 1000} seconds`],
      environment,
    ];
  }

  return [environment];
}

/** Who created the monitor: a member, an SDK check-in's monitor_config, or a member who left. */
function creatorOf(detail: Detail, context: MonitorContext): string {
  const created = detail.audit.at(-1);

  if (created === undefined) {
    return "-";
  }

  if (created.actorId === null) {
    return "SDK check-in";
  }

  return memberEmail(context.members, created.actorId) ?? "-";
}

function detailRows(detail: Detail, context: MonitorContext): DetailRow[] {
  const modified = detail.audit[0];

  return [
    ...typeRows(detail),
    ["Date created", dateTime(detail.monitor.createdAt)],
    ["Created by", creatorOf(detail, context)],
    [
      "Last modified",
      modified === undefined ? (
        "-"
      ) : (
        <TimeSince key="modified" at={modified.time} label="Last modified" />
      ),
    ],
  ];
}

export function DetailSidebar({
  detail,
  context,
}: {
  detail: Detail;
  context: MonitorContext;
}): JSX.Element {
  const { monitor } = detail;
  const owner = monitor.ownerId === null ? null : memberEmail(context.members, monitor.ownerId);

  return (
    <aside className="monitor-side">
      <Block title="Detect">
        <Detect monitor={monitor} />
      </Block>
      <Block title="Resolve">
        <p>{resolveText(monitor)}</p>
      </Block>
      <Block title="Assign">
        <p>{owner === null ? "Unassigned" : `Assign to ${owner}`}</p>
      </Block>
      {monitor.type === "cron" && (
        <Block title="Schedule">
          <p>
            {scheduleText(monitor.config.schedule)} ({monitor.config.timezone}){" "}
            {monitor.config.schedule.type === "crontab" && (
              <code className="muted">({monitor.config.schedule.crontab})</code>
            )}
          </p>
        </Block>
      )}
      {detail.coverage !== null && <Uptime coverage={detail.coverage} />}
      <Block title="Legend">
        <ul className="legend">
          {LEGEND[monitor.type].map(([status, text]) => (
            <li key={status}>
              <StatusSwatch status={status} />
              {text(monitor)}
            </li>
          ))}
        </ul>
      </Block>
      {monitor.description !== "" && (
        <Block title="Description">
          <p className="pre-wrap">{monitor.description}</p>
        </Block>
      )}
      <Block title="Details">
        <dl className="striped-list">
          {detailRows(detail, context).map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </Block>
    </aside>
  );
}

function Uptime({ coverage }: { coverage: NonNullable<Detail["coverage"]> }): JSX.Element {
  const measured = coverage.successful + coverage.failed;

  return (
    <Block title="Uptime">
      <p className="big-number">
        {measured === 0 ? "—" : `${((coverage.successful / measured) * 100).toFixed(2)}%`}
      </p>
      <p className="muted small">
        Of {measured} measured checks in the last 24 hours. {coverage.unknown} could not run.
      </p>
    </Block>
  );
}
