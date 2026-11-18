// Projects with their last day of events, as the web Projects page. A tap
// opens the issue list filtered to the project.

import type { ApiProject } from "@contract";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import type { JSX } from "react";
import { FlatList, Pressable, RefreshControl, View } from "react-native";

import { Tag, Notice } from "~/components/basics";
import { WideSparkline } from "~/components/charts";
import { Text } from "~/components/text";
import { clockTime, compact } from "~/lib/format";
import { useOrg } from "~/lib/organization";
import { usePalette } from "~/lib/preferences";
import { useApi } from "~/lib/session";
import { RADIUS, SPACE } from "~/lib/theme";

function RateLimit({ project }: { project: ApiProject }): JSX.Element | null {
  if (project.rateLimit === null) {
    return null;
  }

  const why = project.rateLimit.reason === "spike_protection" ? "Spike protection" : "Quota";

  return (
    <Tag label={`${why} until ${clockTime(project.rateLimit.until).slice(0, 5)}`} tone="warning" />
  );
}

function ProjectCard({
  project,
  onPress,
}: {
  project: ApiProject;
  onPress: () => void;
}): JSX.Element {
  const palette = usePalette();

  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        backgroundColor: pressed ? palette.raised : palette.bg,
        borderColor: palette.border,
        borderWidth: 1,
        borderRadius: RADIUS.md,
        padding: SPACE.lg,
        gap: SPACE.sm,
      })}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm }}>
        <View style={{ flex: 1 }}>
          <Text weight="medium" lines={1}>
            {project.name}
          </Text>
          <Text size={12} tone="muted">
            {project.slug}
            {project.platform === null ? "" : ` · ${project.platform}`}
          </Text>
        </View>
        <View style={{ alignItems: "flex-end" }}>
          <Text weight="medium">{compact(project.events24h)}</Text>
          <Text size={11} tone="muted">
            events, 24h
          </Text>
        </View>
      </View>
      <WideSparkline points={project.stats} height={36} />
      <RateLimit project={project} />
      {project.firstEventAt === null && (
        <Text size={12} tone="muted">
          No events yet. Add its DSN to an app from the web UI.
        </Text>
      )}
    </Pressable>
  );
}

export function ProjectsScreen(): JSX.Element {
  const api = useApi();
  const org = useOrg();
  const router = useRouter();
  const projects = useQuery({ queryKey: ["projects", org], queryFn: () => api.projects(org) });

  return (
    <FlatList
      data={projects.data ?? []}
      keyExtractor={(project) => String(project.id)}
      contentContainerStyle={{ padding: SPACE.md, gap: SPACE.md }}
      renderItem={({ item }) => (
        <ProjectCard
          project={item}
          onPress={() =>
            router.navigate({
              pathname: "/",
              params: { project: String(item.id), at: String(Date.now()) },
            })
          }
        />
      )}
      refreshControl={
        <RefreshControl
          refreshing={projects.isRefetching}
          onRefresh={() => void projects.refetch()}
        />
      }
      ListEmptyComponent={
        <Notice
          loading={projects.isPending}
          error={projects.error}
          empty="No projects yet. Create one in the web UI."
          onRetry={() => void projects.refetch()}
        />
      }
    />
  );
}
