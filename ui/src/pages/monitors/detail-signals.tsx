// Uptime and metric detail sections: the uptime timeline and recent checks,
// and the metric chart with its threshold lines (Sentry's uptime
// DetailsTimeline and UptimeChecksTable, and MetricDetectorDetailsChart).

import type { ApiMonitor, Json, MonitorDetail as Detail, MonitorTimeline } from "@contract";
import type { JSX } from "react";

import { TimelineRow, TimelineScale } from "~/components/check-in-timeline";
import { dateTime } from "~/lib/format";
import { getText } from "~/lib/json";

import { DetailSection } from "./parts";

export function UptimeTimeline({ timeline }: { timeline: MonitorTimeline }): JSX.Element {
  return (
    <div className="panel timeline-table single">
      <div className="timeline-table-row head">
        <span />
        <TimelineScale timeline={timeline} />
      </div>
      <div className="timeline-table-row">
        <span />
        <TimelineRow timeline={timeline} scope={timeline.buckets[0]?.scope ?? ""} />
      </div>
    </div>
  );
}

// A Map rather than a record so an outcome string from evidence can be looked
// up without a cast; anything unrecognised reads as Unknown.
const UPTIME_STATUS = new Map<string, [label: string, status: string]>([
  ["ok", ["Uptime", "success"]],
  ["failed", ["Failure", "failure"]],
]);

/** Why a check failed, from its evidence: the HTTP status when that was the reason. */
function reasonText(evidence: Json): string {
  const reason = getText(evidence, "reason");
  const httpStatus = getText(evidence, "httpStatus");

  if (reason === null) {
    return "";
  }

  return reason === "status" && httpStatus !== null
    ? `(HTTP ${httpStatus})`
    : `(${reason.replaceAll("_", " ")})`;
}

export function RecentChecks({ detail }: { detail: Detail }): JSX.Element {
  return (
    <DetailSection title="Recent Checks">
      {detail.observations.length === 0 ? (
        <div className="panel empty-state muted">No matching uptime checks found</div>
      ) : (
        <table className="rows panel">
          <thead>
            <tr>
              <th>Timestamp</th>
              <th>Status</th>
              <th>HTTP Code</th>
              <th>Duration</th>
            </tr>
          </thead>
          <tbody>
            {detail.observations.slice(0, 20).map((observation) => {
              const outcome = getText(observation.evidence, "outcome") ?? "unknown";
              const [label, status] = UPTIME_STATUS.get(outcome) ?? ["Unknown", "unknown"];
              const httpStatus = getText(observation.evidence, "httpStatus");
              const durationMs = getText(observation.evidence, "durationMs");

              return (
                <tr key={observation.id}>
                  <td>{dateTime(observation.time)}</td>
                  <td>
                    <span className={`status-text status-${status}`}>
                      <span className={`dot status-${status}`} /> {label}{" "}
                      <span className="muted">{reasonText(observation.evidence)}</span>
                    </span>
                  </td>
                  <td>{httpStatus ?? <span className="muted">—</span>}</td>
                  <td>
                    {durationMs === null ? <span className="muted">—</span> : `${durationMs}ms`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </DetailSection>
  );
}

type MetricMonitor = Extract<ApiMonitor, { type: "metric" }>;

const CHART_HEIGHT = 180;

/** The largest window count in each bucket that has one; buckets with no evaluation are absent. */
function bucketValues(timeline: MonitorTimeline): Map<number, number> {
  const values = new Map<number, number>();

  for (const { index, value } of timeline.buckets) {
    // Unknown and awaiting-data evaluations carry no count: a gap, not zero errors.
    if (value === null) {
      continue;
    }

    const seen = values.get(index);

    values.set(index, seen === undefined ? value : Math.max(seen, value));
  }

  return values;
}

/** A run of consecutive buckets with a value, from bucket `start`. */
type Run = { start: number; values: number[] };

/** Runs of consecutive buckets with a value, each drawn as its own segment so gaps stay empty. */
function runsOf(values: Map<number, number>): Run[] {
  const runs: Run[] = [];

  for (const [index, value] of [...values].toSorted(([a], [b]) => a - b)) {
    const run = runs.at(-1);

    if (run !== undefined && run.start + run.values.length === index) {
      run.values.push(value);
    } else {
      runs.push({ start: index, values: [value] });
    }
  }

  return runs;
}

/**
 * Error counts as steps: each bucket spans [index/total, (index+1)/total] of
 * the width, the scale TimelineScale's labels use, with dashed thresholds.
 */
export function MetricChart({
  monitor,
  timeline,
}: {
  monitor: MetricMonitor;
  timeline: MonitorTimeline;
}): JSX.Element {
  const total = Math.ceil((timeline.until - timeline.since) / timeline.bucketMs);
  const values = bucketValues(timeline);
  const { threshold, warningThreshold } = monitor.config;
  const peak = Math.max(threshold, warningThreshold ?? 0, ...values.values(), 1) * 1.15;
  const y = (value: number): number => CHART_HEIGHT - (value / peak) * CHART_HEIGHT;
  const x = (edge: number): number => (edge / total) * 1000;

  const segments = runsOf(values).map(({ start, values: counts }) => {
    const steps = counts.flatMap((count, offset) => [
      `${x(start + offset)},${y(count)}`,
      `${x(start + offset + 1)},${y(count)}`,
    ]);

    const end = start + counts.length;

    return {
      key: start,
      line: steps.join(" "),
      area: `${x(start)},${CHART_HEIGHT} ${steps.join(" ")} ${x(end)},${CHART_HEIGHT}`,
    };
  });

  return (
    <div className="panel metric-chart">
      <svg
        viewBox={`0 0 1000 ${CHART_HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="Error count per window"
      >
        {segments.map((segment) => (
          <g key={segment.key}>
            <polygon className="area" points={segment.area} />
            <polyline className="line" points={segment.line} />
          </g>
        ))}
        <line className="threshold high" x1="0" x2="1000" y1={y(threshold)} y2={y(threshold)} />
        {warningThreshold !== undefined && (
          <line
            className="threshold medium"
            x1="0"
            x2="1000"
            y1={y(warningThreshold)}
            y2={y(warningThreshold)}
          />
        )}
      </svg>
      <TimelineScale timeline={timeline} />
    </div>
  );
}
