// Event counts over time, drawn as Sentry draws them in its accent colour:
// the small bar trend on list rows, the trend line on project cards, and the
// issue page's bar chart, where a tap on a bar says what it counts.

import type { StatPoint } from "@contract";
import { useState } from "react";
import type { JSX } from "react";
import { Pressable, View } from "react-native";
import Svg, { Path, Rect } from "react-native-svg";

import { bucketLabel } from "~/lib/format";
import { usePalette } from "~/lib/preferences";
import { SPACE } from "~/lib/theme";

import { Text } from "./text";

function peak(points: StatPoint[]): number {
  return Math.max(1, ...points.map(([, count]) => count));
}

/** A bar per bucket, as the trend column of Sentry's issue stream. */
export function MiniBars({
  points,
  width = 60,
  height = 22,
}: {
  points: StatPoint[];
  width?: number;
  height?: number;
}): JSX.Element {
  const palette = usePalette();
  const top = peak(points);
  const slot = points.length === 0 ? 0 : width / points.length;

  return (
    <Svg width={width} height={height}>
      {points.map(([bucket, count], index) => {
        // An empty bucket still shows as a hairline, so a quiet hour reads as zero.
        const bar = count === 0 ? 1 : Math.max(2, (count / top) * height);

        return (
          <Rect
            key={bucket}
            x={index * slot}
            y={height - bar}
            width={Math.max(1, slot - 1)}
            height={bar}
            fill={count === 0 ? palette.border : palette.accent}
          />
        );
      })}
    </Svg>
  );
}

/** A filled trend line. */
function Sparkline({
  points,
  width,
  height,
}: {
  points: StatPoint[];
  width: number;
  height: number;
}): JSX.Element {
  const palette = usePalette();
  const top = peak(points);
  const step = points.length > 1 ? width / (points.length - 1) : width;

  const line = points
    .map(([, count], index) => {
      const x = index * step;
      const y = height - 1 - (count / top) * (height - 2);

      return `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <Svg width={width} height={height}>
      {points.length > 0 && (
        <>
          <Path
            d={`${line} L${width} ${height} L0 ${height} Z`}
            fill={palette.accent}
            fillOpacity={0.2}
          />
          <Path d={line} stroke={palette.accent} strokeWidth={1.5} fill="none" />
        </>
      )}
    </Svg>
  );
}

/** A trend line as wide as its container. */
export function WideSparkline({
  points,
  height,
}: {
  points: StatPoint[];
  height: number;
}): JSX.Element {
  const [width, setWidth] = useState(0);

  return (
    <View onLayout={(event) => setWidth(event.nativeEvent.layout.width)} style={{ height }}>
      {width > 0 && <Sparkline points={points} width={width} height={height} />}
    </View>
  );
}

const CHART_HEIGHT = 84;

type BarChartProps = {
  points: StatPoint[];
  /** Each bucket's span, in milliseconds. */
  step: number;
  /** The left end of the axis: "24h ago". */
  start: string;
  /** The axis's middle until a bar is tapped. */
  summary: string;
};

/** Bars per bucket over a time axis. Tapping a bar shows its span and count. */
export function BarChart({ points, step, start, summary }: BarChartProps): JSX.Element {
  const palette = usePalette();
  const [width, setWidth] = useState(0);
  const [picked, setPicked] = useState<number | null>(null);
  const top = peak(points);
  const slot = points.length === 0 ? 0 : width / points.length;
  const chosen = picked === null ? undefined : points[picked];

  return (
    <View style={{ gap: 6 }}>
      <View
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
        style={{ height: CHART_HEIGHT, borderBottomWidth: 1, borderBottomColor: palette.border }}
      >
        <Svg width={width} height={CHART_HEIGHT - 1}>
          {points.map(([bucket, count], index) => {
            const height = count === 0 ? 1 : Math.max(2, (count / top) * (CHART_HEIGHT - 5));

            return (
              <Rect
                key={bucket}
                x={index * slot + 1}
                y={CHART_HEIGHT - 1 - height}
                width={Math.max(1, slot - 2)}
                height={height}
                rx={1}
                fill={count === 0 ? palette.border : palette.accent}
                opacity={picked === null || index === picked ? 1 : 0.35}
              />
            );
          })}
        </Svg>
        <View style={{ position: "absolute", inset: 0, flexDirection: "row" }}>
          {points.map(([bucket, count], index) => (
            <Pressable
              key={bucket}
              style={{ flex: 1 }}
              accessibilityLabel={`${bucketLabel(bucket, step)}: ${count} events`}
              onPress={() => setPicked(index === picked ? null : index)}
            />
          ))}
        </View>
      </View>
      <View style={{ flexDirection: "row", justifyContent: "space-between", gap: SPACE.sm }}>
        <Text size={12} tone="muted">
          {start}
        </Text>
        <Text size={12} tone={chosen === undefined ? "muted" : "heading"} lines={1}>
          {chosen === undefined
            ? summary
            : `${bucketLabel(chosen[0], step)}: ${chosen[1].toLocaleString()} events`}
        </Text>
        <Text size={12} tone="muted">
          Now
        </Text>
      </View>
    </View>
  );
}
