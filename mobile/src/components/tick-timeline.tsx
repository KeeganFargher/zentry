// The tick timeline of Sentry's Cron and Uptime pages
// (static/app/components/checkInTimeline): one 14px row per environment,
// neighbouring buckets of the same status merged into one bar. Timeouts,
// failed uptime checks and unknowns are hatched, as Sentry draws them. The
// web UI's version is ui/src/components/check-in-timeline.tsx.

import type { MonitorTimeline, TimelineStatus } from "@contract";
import { useState } from "react";
import type { JSX } from "react";
import { Pressable, View } from "react-native";
import Svg, { Defs, Line, Pattern, Rect } from "react-native-svg";

import { minuteTime, shortDateTime } from "~/lib/format";
import { TICK_LABELS, TICK_PRECEDENCE } from "~/lib/monitor-text";
import { usePalette } from "~/lib/preferences";
import type { Palette } from "~/lib/theme";

import { Text } from "./text";

const ROW_HEIGHT = 14;

export type Tick = {
  start: number;
  end: number;
  status: TimelineStatus;
  counts: Map<TimelineStatus, number>;
};

/** Which palette colour each status's tick takes, as the web UI's status classes. */
const TICK_COLORS: Record<TimelineStatus, keyof Palette> = {
  ok: "tickGood",
  success: "tickGood",
  error: "tickBad",
  downtime: "tickBad",
  high: "tickBad",
  timeout: "tickBad",
  failure: "tickBad",
  missed: "tickMeh",
  medium: "tickMeh",
  in_progress: "faint",
  unknown: "tickNeutral",
};

/** The colour of a status's tick, and of its dot beside a check-in. */
export function tickColor(palette: Palette, status: TimelineStatus): string {
  return palette[TICK_COLORS[status]];
}

const HATCHED = new Set<TimelineStatus>(["timeout", "failure", "unknown"]);

/** One scope's ticks: each bucket's most severe status, runs of the same merged. */
export function ticksOf(timeline: MonitorTimeline, scope: string): Tick[] {
  const byIndex = new Map<number, Map<TimelineStatus, number>>();

  for (const bucket of timeline.buckets.filter((entry) => entry.scope === scope)) {
    const counts = byIndex.get(bucket.index) ?? new Map<TimelineStatus, number>();

    counts.set(bucket.status, (counts.get(bucket.status) ?? 0) + bucket.count);
    byIndex.set(bucket.index, counts);
  }

  const ticks: Tick[] = [];

  // Copied, then sorted in place: the app's Hermes has no Array.prototype.toSorted.
  for (const [index, counts] of [...byIndex.entries()].sort(([a], [b]) => a - b)) {
    const status = TICK_PRECEDENCE.find((candidate) => (counts.get(candidate) ?? 0) > 0);

    if (status === undefined) {
      throw new Error(`A timeline bucket with no status we know: ${[...counts.keys()].join(",")}`);
    }

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

/** The environments with ticks, sorted; one unnamed row for a monitor without them. */
export function scopesOf(timeline: MonitorTimeline): string[] {
  const scopes = [...new Set(timeline.buckets.map(({ scope }) => scope))].sort();

  return scopes.length === 0 ? [""] : scopes;
}

function bucketCount(timeline: MonitorTimeline): number {
  return Math.ceil((timeline.until - timeline.since) / timeline.bucketMs);
}

/** Diagonal stripes to fill the hatched ticks with, as Sentry's 45° hatch. */
function Hatches({ palette }: { palette: Palette }): JSX.Element {
  return (
    <Defs>
      {(["hatchBad", "hatchNeutral"] as const).map((key) => (
        <Pattern
          key={key}
          id={key}
          width={4}
          height={4}
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <Line x1={0} y1={0} x2={0} y2={4} stroke={palette[key]} strokeWidth={2} />
        </Pattern>
      ))}
    </Defs>
  );
}

type RowProps = {
  timeline: MonitorTimeline;
  scope: string;
  /** Called with the tapped tick; the row is not tappable without it. */
  onPick?: (tick: Tick) => void;
};

/** One environment's row of ticks, sized to the width it is given. */
export function TickRow({ timeline, scope, onPick }: RowProps): JSX.Element {
  const palette = usePalette();
  const [width, setWidth] = useState(0);
  const slot = width / bucketCount(timeline);
  const ticks = ticksOf(timeline, scope);

  return (
    <View
      style={{ height: ROW_HEIGHT, backgroundColor: palette.raised, borderRadius: 2 }}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
    >
      {width > 0 && (
        <Svg width={width} height={ROW_HEIGHT}>
          <Hatches palette={palette} />
          {ticks.map((tick) => {
            const color = tickColor(palette, tick.status);
            const hatched = HATCHED.has(tick.status);
            const fill = tick.status === "unknown" ? "url(#hatchNeutral)" : "url(#hatchBad)";

            return (
              <Rect
                key={tick.start}
                x={tick.start * slot + 0.5}
                y={0.5}
                // At least two points wide, so a single check-in in a long range shows.
                width={Math.max((tick.end - tick.start) * slot - 1, 2)}
                height={ROW_HEIGHT - 1}
                rx={2}
                fill={hatched ? fill : color}
                stroke={hatched ? color : "none"}
                strokeWidth={1}
              />
            );
          })}
        </Svg>
      )}
      {onPick !== undefined && width > 0 && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${scope === "" ? "Timeline" : scope} ticks. Tap one for its counts`}
          style={{ position: "absolute", inset: 0 }}
          onPress={(event) => {
            const index = Math.floor(event.nativeEvent.locationX / slot);
            const tick = ticks.find(({ start, end }) => index >= start && index < end);

            if (tick !== undefined) {
              onPick(tick);
            }
          }}
        />
      )}
    </View>
  );
}

/** A tapped tick's span and counts: "02:00 – 02:30 · 1 Failed, 1 Okay". */
export function TickSummary({
  tick,
  timeline,
}: {
  tick: Tick;
  timeline: MonitorTimeline;
}): JSX.Element {
  const from = timeline.since + tick.start * timeline.bucketMs;
  const to = timeline.since + tick.end * timeline.bucketMs;

  const counts = [...tick.counts.entries()]
    .map(([status, count]) => `${count} ${TICK_LABELS[status]}`)
    .join(", ");

  return (
    <Text size={12} tone="muted">
      {shortDateTime(from)} – {minuteTime(to)} · {counts}
    </Text>
  );
}
