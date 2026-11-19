// The tick timeline of Sentry's Cron and Uptime pages
// (static/app/components/checkInTimeline): one 14px row per environment,
// neighbouring buckets of the same status merged into one bar.

import type { MonitorTimeline, TimelineStatus } from "@contract";
import type { JSX } from "react";

import { Tooltip } from "~/components/tooltip";
import { dateTime, minuteTime, shortDate } from "~/lib/format";
import { TICK_LABELS, TICK_PRECEDENCE } from "~/lib/monitor-text";

type Tick = {
  start: number;
  end: number;
  status: TimelineStatus;
  counts: Map<TimelineStatus, number>;
};

function bucketCount(timeline: MonitorTimeline): number {
  return Math.ceil((timeline.until - timeline.since) / timeline.bucketMs);
}

/** One scope's per-bucket counts, keyed by bucket index. */
function countsByIndex(
  timeline: MonitorTimeline,
  scope: string,
): Map<number, Map<TimelineStatus, number>> {
  const byIndex = new Map<number, Map<TimelineStatus, number>>();

  for (const bucket of timeline.buckets.filter((entry) => entry.scope === scope)) {
    const counts = byIndex.get(bucket.index) ?? new Map<TimelineStatus, number>();

    counts.set(bucket.status, (counts.get(bucket.status) ?? 0) + bucket.count);
    byIndex.set(bucket.index, counts);
  }

  return byIndex;
}

/** The status a bucket shows: the most severe one it holds, as Sentry's tick precedence. */
function statusOf(counts: Map<TimelineStatus, number>): TimelineStatus {
  return TICK_PRECEDENCE.find((candidate) => (counts.get(candidate) ?? 0) > 0) ?? "unknown";
}

/** Each bucket's counts for one scope, then runs of the same status merged. */
function ticksOf(timeline: MonitorTimeline, scope: string): Tick[] {
  const ticks: Tick[] = [];
  const byIndex = countsByIndex(timeline, scope);

  for (const [index, counts] of [...byIndex.entries()].toSorted(([a], [b]) => a - b)) {
    const status = statusOf(counts);
    const last = ticks.at(-1);

    if (last !== undefined && last.end === index && last.status === status) {
      last.end = index + 1;
      counts.forEach((count, key) => last.counts.set(key, (last.counts.get(key) ?? 0) + count));
    } else {
      ticks.push({ start: index, end: index + 1, status, counts: new Map(counts) });
    }
  }

  return ticks;
}

function TickCard({ tick, timeline }: { tick: Tick; timeline: MonitorTimeline }): JSX.Element {
  const from = timeline.since + tick.start * timeline.bucketMs;
  const to = timeline.since + tick.end * timeline.bucketMs;

  return (
    <div className="tick-card">
      <div className="muted">
        {dateTime(from)} — {minuteTime(to)}
      </div>
      <table>
        <tbody>
          {[...tick.counts.entries()].map(([status, count]) => (
            <tr key={status}>
              <td className={`tick-label status-${status}`}>{TICK_LABELS[status]}</td>
              <td>{count}</td>
              <td className="muted">{count === 1 ? "check-in" : "check-ins"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type RowProps = { timeline: MonitorTimeline; scope: string };

export function TimelineRow({ timeline, scope }: RowProps): JSX.Element {
  const total = bucketCount(timeline);

  return (
    <div className="tick-row" role="img" aria-label={`Check-ins for ${scope || "this monitor"}`}>
      {ticksOf(timeline, scope).map((tick) => (
        <span
          key={tick.start}
          className="tick-slot"
          style={{
            left: `${(tick.start / total) * 100}%`,
            width: `max(4px, ${((tick.end - tick.start) / total) * 100}%)`,
          }}
        >
          <Tooltip
            content={<TickCard tick={tick} timeline={timeline} />}
            className={`tick status-${tick.status}`}
          >
            {null}
          </Tooltip>
        </span>
      ))}
    </div>
  );
}

/** Five evenly spaced time labels; the first carries the date, as Sentry's grid labels. */
export function TimelineScale({ timeline }: { timeline: MonitorTimeline }): JSX.Element {
  const span = timeline.until - timeline.since;
  const steps = [0, 1, 2, 3, 4].map((step) => timeline.since + (span * step) / 5);
  const daily = span > 2 * 24 * 60 * 60 * 1000;

  return (
    <div className="tick-scale" aria-hidden="true">
      {steps.map((at, step) => (
        <span key={at} style={{ left: `${step * 20}%` }}>
          {step === 0 || daily ? shortDate(at) : ""} {daily ? "" : minuteTime(at)}
        </span>
      ))}
    </div>
  );
}

/** A small round status swatch, as Sentry's `MonitorIndicator`. */
export function StatusSwatch({ status }: { status: TimelineStatus }): JSX.Element {
  return <span className={`swatch status-${status}`} aria-hidden="true" />;
}
