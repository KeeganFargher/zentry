// A monitor's page, laid out as Sentry's detector detail: a toolbar and the
// type's visualization, issues, checks and alerts on the left; Detect,
// Resolve, Schedule and Details on the right.

import type { ApiMonitor, ApiProject, MonitorDetail as Detail } from "@contract";
import { useState } from "react";
import type { JSX } from "react";

import { Notice } from "~/components/basics";
import { Icon } from "~/components/icons";
import { Menu } from "~/components/overlays";
import { api, ApiFailure } from "~/lib/api";
import { useNow } from "~/lib/clock";
import { TYPE_LABELS, TYPE_PATHS } from "~/lib/monitor-text";
import { useResource } from "~/lib/resource";
import { navigate } from "~/lib/router";
import { toast } from "~/lib/toast";

import { CronOnboarding, CronTimeline, RecentCheckIns } from "./detail-cron";
import { Activity, ConnectedAlerts, OngoingIssues } from "./detail-sections";
import { DetailSidebar } from "./detail-sidebar";
import { MetricChart, RecentChecks, UptimeTimeline } from "./detail-signals";
import { projectOf, TopBar, useMonitorContext } from "./parts";
import type { MonitorContext } from "./parts";
import { dsnStateOf } from "./sdk-guide";

const DAY = 24 * 60 * 60 * 1000;

// Check-ins are kept 30 days and observations 14 (src/db/monitors.ts).
const PERIODS: [label: string, days: number][] = [
  ["24H", 1],
  ["7D", 7],
  ["14D", 14],
];

const DISABLED_TEXT: Record<ApiMonitor["type"], string> = {
  cron: "This monitor is disabled and not accepting check-ins.",
  uptime: "This monitor is disabled and not recording uptime checks.",
  metric: "This monitor is disabled and not creating issues.",
};

const MUTES: [label: string, minutes: number][] = [
  ["Mute for 1 hour", 60],
  ["Mute for 1 day", 24 * 60],
  ["Mute for 7 days", 7 * 24 * 60],
];

type PageProps = { org: string; detail: Detail; context: MonitorContext; reload: () => void };

type Run = (action: () => Promise<ApiMonitor>, message: string) => void;

/** Mute for a fixed time, or Unmute while muted, as Sentry's detector mute menu. */
function MuteMenu({
  org,
  monitor,
  run,
}: {
  org: string;
  monitor: ApiMonitor;
  run: Run;
}): JSX.Element {
  const now = useNow();
  const muted = monitor.mutedUntil !== null && monitor.mutedUntil > now;

  // The mute end is taken when chosen, not at render, so it is exactly N from the click.
  const mutes = MUTES.map(([label, minutes]) => ({
    label,
    onSelect: () =>
      run(
        () => api.muteMonitor(org, monitor, { until: Date.now() + minutes * 60_000 }),
        "Monitor muted",
      ),
  }));

  const unmute = {
    label: "Unmute",
    onSelect: () => run(() => api.muteMonitor(org, monitor, { until: null }), "Monitor unmuted"),
  };

  return (
    <Menu label="Mute" items={muted ? [unmute] : mutes}>
      {muted ? "Muted" : "Mute"}
    </Menu>
  );
}

/**
 * Runs a toolbar action. An API refusal (a member's 403, a stale version's
 * 409) is shown as a toast, and the page reloads so it shows what is stored;
 * any other error is a bug and is rethrown.
 */
async function perform(
  action: () => Promise<ApiMonitor>,
  message: string,
  reload: () => void,
): Promise<void> {
  try {
    await action();
    toast(message);
  } catch (cause) {
    if (!(cause instanceof ApiFailure)) {
      throw cause;
    }

    toast(`Could not update the monitor: ${cause.message}`);
  }

  reload();
}

function Toolbar({
  org,
  detail,
  reload,
  days,
  setDays,
}: PageProps & { days: number; setDays: (days: number) => void }): JSX.Element {
  const { monitor } = detail;
  const paused = monitor.status === "paused";

  const run: Run = (action, message) => void perform(action, message, reload);

  return (
    <div className="detail-toolbar">
      <select
        aria-label="Time period"
        value={days}
        onChange={(event) => setDays(Number(event.target.value))}
      >
        {PERIODS.map(([label, value]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      <span className="spacer" />
      <MuteMenu org={org} monitor={monitor} run={run} />
      <button
        type="button"
        className="small"
        onClick={() =>
          run(
            () => api.setMonitorStatus(org, monitor, paused ? "active" : "paused"),
            paused ? "Monitor enabled" : "Monitor disabled",
          )
        }
      >
        {paused ? "Enable" : "Disable"}
      </button>
      <button
        type="button"
        className="small primary"
        onClick={() => navigate(`/${org}/monitors/${monitor.id}/edit/`)}
      >
        <Icon name="edit" size={12} /> Edit
      </button>
    </div>
  );
}

type CronMonitor = Extract<ApiMonitor, { type: "cron" }>;

/** The setup guide, with the project's active DSN filled in once its keys load. */
function CronSetup({
  org,
  monitor,
  project,
}: {
  org: string;
  monitor: CronMonitor;
  project: ApiProject;
}): JSX.Element {
  const keys = useResource(`keys:${org}:${project.slug}`, () => api.keys(org, project.slug));

  // The guide tells loading, a failed load and a project with no active key apart.
  return <CronOnboarding monitor={monitor} dsn={dsnStateOf(keys)} />;
}

/** The type's chart over the chosen period: cron and uptime ticks, or the metric area. */
function TimelineSignal({
  org,
  detail,
  days,
}: {
  org: string;
  detail: Detail;
  days: number;
}): JSX.Element {
  const { monitor } = detail;
  const until = Math.ceil(useNow() / 60_000) * 60_000;
  const since = until - days * DAY;

  // Keyed on the newest observation too, so a fresh check refetches the timeline.
  const timeline = useResource(
    `timeline:${monitor.id}:${days}:${detail.observations[0]?.id ?? 0}`,
    () => api.monitorTimeline(org, monitor.id, { since, until, buckets: 120 }),
  );

  const data = timeline.data;

  if (data === null) {
    return <Notice loading={timeline.loading} error={timeline.error} onRetry={timeline.reload} />;
  }

  if (monitor.type === "cron") {
    return <CronTimeline detail={detail} timeline={data} />;
  }

  return monitor.type === "uptime" ? (
    <UptimeTimeline timeline={data} />
  ) : (
    <MetricChart monitor={monitor} timeline={data} />
  );
}

function Signal({
  org,
  detail,
  project,
  days,
}: {
  org: string;
  detail: Detail;
  project: ApiProject | undefined;
  days: number;
}): JSX.Element {
  const { monitor } = detail;

  // Sentry shows the setup guide in place of the timeline until the first check-in.
  if (monitor.type === "cron" && detail.scopes.every(({ lastCheckIn }) => lastCheckIn === null)) {
    // The guide needs the project's DSN; a monitor whose project is gone has none to show.
    return project === undefined ? (
      <Notice loading={false} error="This monitor's project is no longer in this organization." />
    ) : (
      <CronSetup org={org} monitor={monitor} project={project} />
    );
  }

  return <TimelineSignal org={org} detail={detail} days={days} />;
}

function Page({ org, detail, context, reload }: PageProps): JSX.Element {
  const [days, setDays] = useState(1);
  const { monitor } = detail;
  const project = projectOf(context.projects, monitor);

  return (
    <>
      <TopBar
        crumbs={[
          { label: "Monitors", to: `/${org}/monitors/` },
          { label: TYPE_LABELS[monitor.type], to: `/${org}/monitors/${TYPE_PATHS[monitor.type]}/` },
          { label: monitor.name },
        ]}
      />
      <div className="content monitor-detail">
        <div className="monitor-main">
          <Toolbar
            org={org}
            detail={detail}
            context={context}
            reload={reload}
            days={days}
            setDays={setDays}
          />
          {monitor.status === "paused" && (
            <div className="alert-banner muted">{DISABLED_TEXT[monitor.type]}</div>
          )}
          <Signal org={org} detail={detail} project={project} days={days} />
          <OngoingIssues org={org} detail={detail} />
          {monitor.type === "cron" && <RecentCheckIns detail={detail} />}
          {monitor.type === "uptime" && <RecentChecks detail={detail} />}
          <ConnectedAlerts org={org} detail={detail} context={context} />
          <Activity detail={detail} context={context} />
        </div>
        <DetailSidebar detail={detail} context={context} />
      </div>
    </>
  );
}

export function MonitorDetail({ org, id }: { org: string; id: string }): JSX.Element {
  const detail = useResource(`monitor:${org}:${id}`, () => api.monitor(org, id));
  const context = useMonitorContext(org);

  if (detail.data === null || context.data === null) {
    return (
      <>
        <TopBar crumbs={[{ label: "Monitors", to: `/${org}/monitors/` }, { label: "Monitor" }]} />
        <div className="content">
          <Notice
            loading={detail.loading || context.loading}
            error={detail.error ?? context.error}
            onRetry={() => {
              // Retry whichever failed: the monitor, or the projects, members and rules.
              detail.reload();
              context.reload();
            }}
          />
        </div>
      </>
    );
  }

  return <Page org={org} detail={detail.data} context={context.data} reload={detail.reload} />;
}
