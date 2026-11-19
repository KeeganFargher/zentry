// The organization's monitors, read-only: Sentry's Monitors page, with its
// type sections as a segmented control. Creating and editing stay on the web.
//
// Each row's timeline is its own request, and a paired phone shares one rate
// limit (120 a minute) with every other screen. So, as on the web, timelines
// show only on the Crons and Uptime lists, never on "All", and FlatList mounts
// a few screens' worth of rows rather than its default twenty-one.

import type { ApiMonitor, ApiProject } from "@contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useState } from "react";
import type { JSX } from "react";
import { FlatList, RefreshControl, View } from "react-native";

import { Notice } from "~/components/basics";
import { Segmented } from "~/components/segmented";
import { Text } from "~/components/text";
import { detailsOf, TYPE_LABELS } from "~/lib/monitor-text";
import { useOrg } from "~/lib/organization";
import { usePalette } from "~/lib/preferences";
import { useApi } from "~/lib/session";
import { SPACE } from "~/lib/theme";

import { useMonitors } from "./data";
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

/** Type, what it watches, and its project once the projects have loaded. */
function detailsLine(monitor: ApiMonitor, projects: ApiProject[]): string[] {
  const project = projects.find(({ id }) => id === monitor.projectId);
  const line = [TYPE_LABELS[monitor.type], ...detailsOf(monitor)];

  return project === undefined ? line : [...line, project.slug];
}

type HeaderProps = {
  filter: Filter;
  onFilter: (filter: Filter) => void;
  projectsError: Error | null;
};

function ListHeader({ filter, onFilter, projectsError }: HeaderProps): JSX.Element {
  return (
    <View style={{ padding: SPACE.md, gap: SPACE.sm }}>
      <Segmented options={FILTERS} value={filter} onChange={onFilter} label="Monitor type" fill />
      {projectsError !== null && (
        <Text size={12} tone="danger">
          Could not load projects, so rows leave them out: {projectsError.message}
        </Text>
      )}
    </View>
  );
}

export function MonitorsScreen(): JSX.Element {
  const api = useApi();
  const org = useOrg();
  const router = useRouter();
  const palette = usePalette();
  const client = useQueryClient();
  const [filter, setFilter] = useState<Filter>("all");
  const monitors = useMonitors();
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
      initialNumToRender={8}
      windowSize={5}
      ListHeaderComponent={
        <ListHeader filter={filter} onFilter={setFilter} projectsError={projects.error} />
      }
      renderItem={({ item }) => (
        <MonitorRow
          monitor={item}
          details={detailsLine(item, projects.data ?? [])}
          withTimeline={filter !== "all"}
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
