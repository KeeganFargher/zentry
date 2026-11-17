// The bar chart used for every event series: one bar per time bucket, with
// a tooltip for the bucket under the pointer.

import type { StatPoint } from "@contract";
import { useState } from "react";
import type { JSX } from "react";

import { bucketLabel } from "~/lib/format";

type ChartProps = {
  points: StatPoint[];
  height: number;
  /** A moment to mark with a line, such as the event being shown. */
  marker?: number | null;
};

type TipProps = { point: StatPoint; step: number; position: number; marked: boolean };

/** Anchored to the hovered bar; near either edge it grows inward so it is never clipped. */
function Tip({ point, step, position, marked }: TipProps): JSX.Element {
  const [bucket, count] = point;
  const side = position < 0.25 ? "start" : "end";
  const anchor = position > 0.25 && position < 0.75 ? "middle" : side;

  return (
    <div className={`chart-tip ${anchor}`} style={{ left: `${position * 100}%` }} role="tooltip">
      <div className="when">{bucketLabel(bucket, step)}</div>
      <div className="series">
        <span className="swatch" />
        <span>Events</span>
        <strong>{count.toLocaleString()}</strong>
      </div>
      {marked && (
        <div className="series">
          <span className="swatch marker" />
          <span>Current Event</span>
        </div>
      )}
    </div>
  );
}

function barHeight(count: number, max: number): string {
  return count === 0 ? "1px" : `max(2px, ${(count / max) * 100}%)`;
}

/** The bucket holding `at`, if the chart covers it. */
function markedIndex(points: StatPoint[], step: number, at: number): number {
  return points.findIndex(([bucket]) => at >= bucket && at < bucket + step);
}

export function BarChart({ points, height, marker = null }: ChartProps): JSX.Element {
  const [hovered, setHovered] = useState<number | null>(null);
  const max = Math.max(1, ...points.map(([, count]) => count));
  const step = (points[1]?.[0] ?? 0) - (points[0]?.[0] ?? 0);
  const active = hovered === null ? undefined : points[hovered];
  const marked = marker === null ? -1 : markedIndex(points, step, marker);

  return (
    <div className="bars" style={{ height }} onMouseLeave={() => setHovered(null)}>
      {points.map(([bucket, count], index) => (
        <div
          key={bucket}
          className={index === hovered ? "slot hovered" : "slot"}
          onMouseEnter={() => setHovered(index)}
        >
          <div
            className={count === 0 ? "bar empty" : "bar"}
            style={{ height: barHeight(count, max) }}
          />
          {index === marked && <div className="mark-line" />}
        </div>
      ))}
      {active !== undefined && hovered !== null && (
        <Tip
          point={active}
          step={step}
          position={(hovered + 0.5) / points.length}
          marked={hovered === marked}
        />
      )}
    </div>
  );
}
