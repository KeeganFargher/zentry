// The band under the issue header: the 30-day event chart, with the shown
// event marked, beside the tag panel.

import type { ApiIssue, ApiIssueStats, ApiTag, StatPoint } from "@contract";
import type { JSX } from "react";

import { Count } from "~/components/basics";
import { BarChart } from "~/components/chart";
import { compact, shortDate } from "~/lib/format";

import { TagPanel } from "./issue-tags";

type GraphProps = {
  org: string;
  issue: ApiIssue;
  stats: ApiIssueStats | null;
  tags: ApiTag[];
  /** When the event shown below happened, marked on the chart. */
  current: number | null;
};

const DATE_LABELS = 6;

/** Evenly spaced dates along the bottom of the chart. */
function dateLabels(points: StatPoint[]): number[] {
  const step = Math.max(1, Math.floor(points.length / DATE_LABELS));

  return points.flatMap(([bucket], index) => (index % step === 0 ? [bucket] : []));
}

function EventsChart({
  points,
  current,
}: {
  points: StatPoint[];
  current: number | null;
}): JSX.Element {
  const peak = Math.max(1, ...points.map(([, count]) => count));

  return (
    <div className="big-chart">
      <div className="axis">
        <span>{compact(peak)}</span>
        <span>{compact(Math.round(peak / 2))}</span>
        <span>0</span>
      </div>
      <div className="plot">
        <BarChart points={points} height={96} marker={current} />
      </div>
      <div className="dates">
        {dateLabels(points).map((bucket) => (
          <span key={bucket}>{shortDate(bucket)}</span>
        ))}
      </div>
    </div>
  );
}

/** Explains the gap between the event count and the event list under flood sampling. */
function Sampling({ stats }: { stats: ApiIssueStats }): JSX.Element | null {
  if (stats.stored >= stats.total) {
    return null;
  }

  return (
    <div className="muted small sampling">
      {compact(stats.stored)} of {compact(stats.total)} events are stored in full; the rest were
      counted only.
    </div>
  );
}

export function IssueGraph({ org, issue, stats, tags, current }: GraphProps): JSX.Element {
  return (
    <div className="graph">
      <div className="panel">
        <div className="graph-main">
          <div className="stat-boxes">
            <div className="stat-box">
              <span>Events · 30d</span>
              <strong>
                <Count value={stats?.total ?? 0} />
              </strong>
            </div>
            <div className="stat-box">
              <span>Stored</span>
              <strong>
                <Count value={stats?.stored ?? 0} />
              </strong>
            </div>
          </div>
          {stats === null ? (
            <div className="chart-placeholder" />
          ) : (
            <EventsChart points={stats.points} current={current} />
          )}
        </div>
        {stats !== null && <Sampling stats={stats} />}
      </div>
      <TagPanel org={org} issue={issue} tags={tags} />
    </div>
  );
}
