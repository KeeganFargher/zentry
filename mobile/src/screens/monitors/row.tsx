// One monitor in the list, as Sentry's detector list row folded for a phone:
// name and health, the details line (type, schedule or URL or threshold, and
// project), the last day's ticks for cron and uptime, and the last issue.

import type { ApiMonitor, ApiProject } from "@contract";
import type { JSX } from "react";
import { Pressable, View } from "react-native";

import { Tag } from "~/components/basics";
import type { TagTone } from "~/components/basics";
import { Text } from "~/components/text";
import { scopesOf, TickRow } from "~/components/tick-timeline";
import { useNow } from "~/lib/clock";
import { timeAgo } from "~/lib/format";
import { detailsOf, HEALTH_LABELS, TYPE_LABELS } from "~/lib/monitor-text";
import { usePalette } from "~/lib/preferences";
import { SPACE } from "~/lib/theme";

import { useTimeline } from "./data";

export const HEALTH_TONES: Record<ApiMonitor["health"], TagTone> = {
  healthy: "success",
  degraded: "warning",
  failing: "danger",
  awaiting_data: "neutral",
  unknown: "neutral",
};

/** A day in 48 half-hour columns: enough to see a pattern on a phone's width. */
const ROW_BUCKETS = 48;

function RowTimeline({ monitor }: { monitor: ApiMonitor }): JSX.Element {
  const timeline = useTimeline(monitor.id, 1, ROW_BUCKETS);

  if (timeline.data === undefined) {
    return (
      <Text size={12} tone="muted">
        {timeline.error === null ? "Loading the last day…" : `Timeline: ${timeline.error.message}`}
      </Text>
    );
  }

  const data = timeline.data;

  return (
    <View style={{ gap: 4 }}>
      {scopesOf(data).map((scope) => (
        <View key={scope} style={{ gap: 2 }}>
          {monitor.type === "cron" && scope !== "" && (
            <Text size={11} tone="muted">
              {scope}
            </Text>
          )}
          <TickRow timeline={data} scope={scope} />
        </View>
      ))}
    </View>
  );
}

function LastIssue({ issue }: { issue: NonNullable<ApiMonitor["lastIssue"]> }): JSX.Element {
  const now = useNow();

  return (
    <Text size={12} tone="muted" lines={1}>
      {issue.shortId} · {issue.title} · {timeAgo(issue.lastSeen, now)}
    </Text>
  );
}

type RowProps = { monitor: ApiMonitor; project: ApiProject | undefined; onPress: () => void };

export function MonitorRow({ monitor, project, onPress }: RowProps): JSX.Element {
  const palette = usePalette();
  const paused = monitor.status !== "active";
  // Projects load separately; until they do, the row says only the type.
  const details = [TYPE_LABELS[monitor.type], ...detailsOf(monitor)];

  if (project !== undefined) {
    details.push(project.slug);
  }

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({
        backgroundColor: pressed ? palette.raised : palette.bg,
        paddingHorizontal: SPACE.lg,
        paddingVertical: SPACE.md,
        gap: SPACE.sm,
        borderBottomWidth: 1,
        borderColor: palette.borderSoft,
        // Sentry fades a disabled monitor's row.
        opacity: paused ? 0.6 : 1,
      })}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm }}>
        <Text weight="medium" lines={1} style={{ flex: 1 }}>
          {monitor.name}
        </Text>
        {paused ? (
          <Tag label={monitor.status === "paused" ? "Disabled" : "Archived"} tone="neutral" />
        ) : (
          <Tag label={HEALTH_LABELS[monitor.health]} tone={HEALTH_TONES[monitor.health]} />
        )}
      </View>
      <Text size={12} tone="muted" lines={2}>
        {details.join(" · ")}
      </Text>
      {monitor.type !== "metric" && <RowTimeline monitor={monitor} />}
      {monitor.lastIssue !== null && <LastIssue issue={monitor.lastIssue} />}
    </Pressable>
  );
}
