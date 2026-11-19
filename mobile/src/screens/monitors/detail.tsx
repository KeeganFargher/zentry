// One monitor, read-only: Sentry's detector detail stacked for a phone. The
// timeline over a chosen period, then what is wrong now, the type's recent
// results, and what it watches. Muting, pausing and editing stay on the web.

import type { ApiMonitor, MonitorDetail } from "@contract";
import { useQueryClient } from "@tanstack/react-query";
import { Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import type { JSX } from "react";
import { RefreshControl, ScrollView, View } from "react-native";

import { Notice, Panel, Tag } from "~/components/basics";
import { Segmented } from "~/components/segmented";
import { SectionTitle, Text } from "~/components/text";
import { scopesOf, TickRow, TickSummary } from "~/components/tick-timeline";
import type { Tick } from "~/components/tick-timeline";
import { useNow } from "~/lib/clock";
import { dateTime, shortDate } from "~/lib/format";
import { detailsOf, HEALTH_LABELS, TYPE_LABELS } from "~/lib/monitor-text";
import { useOrg } from "~/lib/organization";
import { usePalette } from "~/lib/preferences";
import { SPACE } from "~/lib/theme";

import { About } from "./about";
import { useMonitorDetail, useTimeline } from "./data";
import { HEALTH_TONES } from "./row";
import { Coverage, Environments, OngoingIssues, RecentChecks, RecentCheckIns } from "./sections";

// As the web: check-ins are kept 30 days and observations 14 (src/db/monitors.ts).
const PERIODS = [
  ["1", "24H"],
  ["7", "7D"],
  ["14", "14D"],
] as const;

type Period = (typeof PERIODS)[number][0];

/** Columns across a phone: a little over one per 6 points of width. */
const DETAIL_BUCKETS = 60;

const DISABLED_TEXT: Record<ApiMonitor["type"], string> = {
  cron: "This monitor is disabled and not accepting check-ins.",
  uptime: "This monitor is disabled and not recording uptime checks.",
  metric: "This monitor is disabled and not creating issues.",
};

function Summary({ monitor }: { monitor: ApiMonitor }): JSX.Element {
  const now = useNow();
  const muted = monitor.mutedUntil !== null && monitor.mutedUntil > now;

  return (
    <Panel>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: SPACE.xs }}>
        <Tag label={TYPE_LABELS[monitor.type]} tone="accent" />
        <Tag label={HEALTH_LABELS[monitor.health]} tone={HEALTH_TONES[monitor.health]} />
        {muted && <Tag label="Muted" tone="neutral" />}
      </View>
      <Text size={13} tone="muted">
        {detailsOf(monitor).join(" · ")}
      </Text>
      {monitor.status !== "active" && <Text tone="danger">{DISABLED_TEXT[monitor.type]}</Text>}
      {muted && monitor.mutedUntil !== null && (
        <Text size={13} tone="muted">
          Muted until {dateTime(monitor.mutedUntil)}
        </Text>
      )}
    </Panel>
  );
}

function Timeline({ monitor }: { monitor: ApiMonitor }): JSX.Element {
  const [period, setPeriod] = useState<Period>("1");
  const [picked, setPicked] = useState<Tick | null>(null);
  const timeline = useTimeline(monitor.id, Number(period), DETAIL_BUCKETS);
  const data = timeline.data;

  return (
    <Panel>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <SectionTitle>Timeline</SectionTitle>
        <Segmented
          options={PERIODS}
          value={period}
          label="Period"
          onChange={(next) => {
            setPeriod(next);
            setPicked(null);
          }}
        />
      </View>
      {data === undefined ? (
        <Notice
          loading={timeline.isPending}
          error={timeline.error}
          onRetry={() => void timeline.refetch()}
        />
      ) : (
        <View style={{ gap: SPACE.sm }}>
          {scopesOf(data).map((scope) => (
            <View key={scope} style={{ gap: 2 }}>
              {scope !== "" && (
                <Text size={12} tone="muted">
                  {scope}
                </Text>
              )}
              <TickRow timeline={data} scope={scope} onPick={setPicked} />
            </View>
          ))}
          <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
            <Text size={11} tone="muted">
              {shortDate(data.since)}
            </Text>
            <Text size={11} tone="muted">
              Now
            </Text>
          </View>
          {picked === null ? (
            <Text size={12} tone="muted">
              {data.buckets.length === 0
                ? "Nothing in this period yet."
                : "Tap a tick for its counts."}
            </Text>
          ) : (
            <TickSummary tick={picked} timeline={data} />
          )}
        </View>
      )}
    </Panel>
  );
}

/** The sections only the monitor's type has. */
function TypeSections({ detail }: { detail: MonitorDetail }): JSX.Element | null {
  if (detail.monitor.type === "cron") {
    return (
      <>
        <Environments detail={detail} />
        <RecentCheckIns detail={detail} />
      </>
    );
  }

  if (detail.monitor.type === "uptime") {
    return (
      <>
        {detail.coverage !== null && <Coverage coverage={detail.coverage} />}
        <RecentChecks detail={detail} />
      </>
    );
  }

  return null;
}

export function MonitorScreen(): JSX.Element {
  const { id } = useLocalSearchParams<{ id: string }>();
  const palette = usePalette();
  const client = useQueryClient();
  const org = useOrg();
  const detail = useMonitorDetail(id);

  return (
    <>
      <Stack.Screen options={{ title: detail.data?.monitor.name ?? "Monitor" }} />
      <ScrollView
        style={{ backgroundColor: palette.surface }}
        contentContainerStyle={{ padding: SPACE.md, gap: SPACE.md }}
        refreshControl={
          <RefreshControl
            refreshing={detail.isRefetching}
            onRefresh={() => {
              void detail.refetch();
              void client.invalidateQueries({ queryKey: ["monitor-timeline", org, id] });
            }}
          />
        }
      >
        {detail.data === undefined ? (
          <Notice
            loading={detail.isPending}
            error={detail.error}
            onRetry={() => void detail.refetch()}
          />
        ) : (
          <>
            <Summary monitor={detail.data.monitor} />
            <Timeline monitor={detail.data.monitor} />
            <OngoingIssues detail={detail.data} />
            <TypeSections detail={detail.data} />
            <About monitor={detail.data.monitor} />
          </>
        )}
      </ScrollView>
    </>
  );
}
