// The organization's monitors, read-only: Sentry's Monitors page, with its
// type sections as a segmented control. Creating and editing stay on the web.

import type { ApiMonitor } from "@contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useState } from "react";
import type { JSX } from "react";
import { FlatList, RefreshControl, View } from "react-native";

import { Notice } from "~/components/basics";
import { Segmented } from "~/components/segmented";
import { useOrg } from "~/lib/organization";
import { usePalette } from "~/lib/preferences";
import { useApi } from "~/lib/session";
import { SPACE } from "~/lib/theme";

import { MonitorRow } from "./row";

type Filter = "all" | ApiMonitor["type"];

const FILTERS = [
  ["all", "All"],
  ["cron", "Crons"],
  ["uptime", "Uptime"],
  ["metric", "Metrics"],
] as const;

const EMPTY: Record<Filter, string> = {
  all: "No monitors yet. Create one in the web UI.",
  cron: "No cron monitors.",
  uptime: "No uptime monitors.",
  metric: "No metric monitors.",
};

export function MonitorsScreen(): JSX.Element {
  const api = useApi();
  const org = useOrg();
  const router = useRouter();
  const palette = usePalette();
  const client = useQueryClient();
  const [filter, setFilter] = useState<Filter>("all");
  const monitors = useQuery({ queryKey: ["monitors", org], queryFn: () => api.monitors(org) });
  // The issue list and Projects tab load the same query, so this is usually cached.
  const projects = useQuery({ queryKey: ["projects", org], queryFn: () => api.projects(org) });

  const shown = (monitors.data ?? []).filter(
    (monitor) => filter === "all" || monitor.type === filter,
  );

  return (
    <FlatList
      data={shown}
      keyExtractor={(monitor) => monitor.id}
      style={{ backgroundColor: palette.bg }}
      ListHeaderComponent={
        <View style={{ padding: SPACE.md }}>
          <Segmented
            options={FILTERS}
            value={filter}
            onChange={setFilter}
            label="Monitor type"
            fill
          />
        </View>
      }
      renderItem={({ item }) => (
        <MonitorRow
          monitor={item}
          project={projects.data?.find((project) => project.id === item.projectId)}
          onPress={() => router.push({ pathname: "/monitors/[id]", params: { id: item.id } })}
        />
      )}
      refreshControl={
        <RefreshControl
          refreshing={monitors.isRefetching}
          onRefresh={() => {
            void monitors.refetch();
            void client.invalidateQueries({ queryKey: ["monitor-timeline", org] });
          }}
        />
      }
      ListEmptyComponent={
        <Notice
          loading={monitors.isPending}
          error={monitors.error}
          empty={EMPTY[filter]}
          onRetry={() => void monitors.refetch()}
        />
      }
    />
  );
}
