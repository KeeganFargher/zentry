// Cron detail sections: the per-environment timeline, Recent Check-Ins and,
// before the first check-in, the instrumentation panel (Sentry's
// DetailsTimeline, MonitorCheckIns and MonitorOnboarding).

import type {
  ApiMonitor,
  CronCheckInView,
  MonitorDetail as Detail,
  MonitorTimeline,
} from "@contract";
import type { JSX } from "react";

import { TimelineRow, TimelineScale } from "~/components/check-in-timeline";
import { Icon } from "~/components/icons";
import { CopyButton } from "~/components/overlays";
import { dateTime, duration } from "~/lib/format";
import { CHECK_IN_LABELS } from "~/lib/monitor-text";

import { DetailSection } from "./parts";
import { SdkGuide } from "./sdk-guide";

const HEALTH_ICONS = {
  healthy: (
    <span className="env-status ok">
      <Icon name="check" size={12} />
    </span>
  ),
  degraded: (
    <span className="env-status warn">
      <Icon name="warning" size={12} />
    </span>
  ),
  failing: (
    <span className="env-status bad">
      <Icon name="fire" size={12} />
    </span>
  ),
  awaiting_data: (
    <span className="env-status muted" title="Waiting for check-in">
      <Icon name="timer" size={12} />
    </span>
  ),
  // An environment whose health is not known yet shows no icon.
  unknown: null,
} satisfies Record<Detail["scopes"][number]["health"], JSX.Element | null>;

export function CronTimeline({
  detail,
  timeline,
}: {
  detail: Detail;
  timeline: MonitorTimeline;
}): JSX.Element {
  return (
    <div className="panel timeline-table">
      <div className="timeline-table-row head">
        <strong>Check-Ins</strong>
        <TimelineScale timeline={timeline} />
      </div>
      {detail.scopes.map((scope) => (
        <div key={scope.environment} className="timeline-table-row">
          <span className={`env-label health-${scope.health}`}>
            {scope.environment} {HEALTH_ICONS[scope.health]}
          </span>
          <TimelineRow timeline={timeline} scope={scope.environment} />
        </div>
      ))}
    </div>
  );
}

function Started({ checkIn }: { checkIn: CronCheckInView }): JSX.Element {
  if (checkIn.startedAt === null) {
    return <span className="muted">—</span>;
  }

  // A run that reported only its result never said it started, as Sentry's "Not Sent".
  const reportedOnlyEnd =
    checkIn.completedAt === checkIn.startedAt && checkIn.status !== "in_progress";

  return reportedOnlyEnd ? (
    <span className="tag warning">Not Sent</span>
  ) : (
    <>{dateTime(checkIn.startedAt)}</>
  );
}

function Completed({ checkIn }: { checkIn: CronCheckInView }): JSX.Element {
  if (checkIn.status === "missed") {
    return <span className="muted">—</span>;
  }

  if (checkIn.status === "in_progress") {
    return <span className="tag muted">In Progress</span>;
  }

  if (checkIn.completedAt === null) {
    return <span className="tag danger">Incomplete</span>;
  }

  return <>{dateTime(checkIn.completedAt)}</>;
}

function CheckInRow({
  checkIn,
  environments,
}: {
  checkIn: CronCheckInView;
  environments: boolean;
}): JSX.Element {
  return (
    <tr>
      <td>
        <span className={`status-text status-${checkIn.status}`}>
          <span className={`dot status-${checkIn.status}`} /> {CHECK_IN_LABELS[checkIn.status]}
        </span>
      </td>
      <td className="mono">
        {checkIn.status === "missed" ? (
          <span className="muted">—</span>
        ) : (
          <>
            {checkIn.checkInId.slice(0, 8)}{" "}
            <CopyButton text={checkIn.checkInId} message="Copied the check-in ID" />
          </>
        )}
      </td>
      <td>
        <Started checkIn={checkIn} />
      </td>
      <td>
        <Completed checkIn={checkIn} />
      </td>
      <td>
        {checkIn.durationMs === null ? (
          <span className="muted">—</span>
        ) : (
          duration(checkIn.durationMs)
        )}
      </td>
      {environments && <td>{checkIn.environment}</td>}
      <td className="muted">{checkIn.expectedAt === null ? "—" : dateTime(checkIn.expectedAt)}</td>
    </tr>
  );
}

export function RecentCheckIns({ detail }: { detail: Detail }): JSX.Element {
  const environments = new Set(detail.checkIns.map(({ environment }) => environment)).size > 1;

  return (
    <DetailSection title="Recent Check-Ins">
      {detail.checkIns.length === 0 ? (
        <div className="panel empty-state muted">
          No check-ins have been recorded for this time period.
        </div>
      ) : (
        <table className="rows panel">
          <thead>
            <tr>
              <th>Status</th>
              <th>Check-In ID</th>
              <th>Started</th>
              <th>Completed</th>
              <th>Duration</th>
              {environments && <th>Environment</th>}
              <th>Expected At</th>
            </tr>
          </thead>
          <tbody>
            {detail.checkIns.map((checkIn) => (
              <CheckInRow key={checkIn.checkInId} checkIn={checkIn} environments={environments} />
            ))}
          </tbody>
        </table>
      )}
    </DetailSection>
  );
}

type CronMonitor = Extract<ApiMonitor, { type: "cron" }>;

/** Shown until the first check-in arrives, as Sentry's "Instrument your monitor". */
export function CronOnboarding({
  monitor,
  dsn,
}: {
  monitor: CronMonitor;
  dsn: string | null;
}): JSX.Element {
  return (
    <div className="panel onboarding">
      <h2>Instrument your monitor</h2>
      <SdkGuide slug={monitor.config.slug} config={monitor.config} dsn={dsn} />
      <div className="waiting">
        <span className="pulse" />
        <div>
          <strong>Waiting for first Check-in</strong>
          <p className="muted small">
            This Cron Monitor will not detect misses until the first Check-in has been received.
          </p>
        </div>
      </div>
    </div>
  );
}
