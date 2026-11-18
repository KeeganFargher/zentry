// The issue list, as Sentry's issue stream: the page header with search and
// filters, a table header that holds the sort, then the rows, more as you
// scroll. The header floats over the list and collapses into a slim bar as
// it scrolls down (collapse.ts), coming back on the way up. Pull down to
// refresh. A long-press starts selecting, for resolving or archiving many.

import type { ApiIssue, ApiProject, IssueStatus } from "@contract";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { RefreshControl, View } from "react-native";
import Animated, { useAnimatedStyle } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Notice } from "~/components/basics";
import { Button } from "~/components/button";
import { Text } from "~/components/text";
import { useNow } from "~/lib/clock";
import { useSetStatus } from "~/lib/issue-actions";
import { useOrg, useOrganization } from "~/lib/organization";
import { usePalette } from "~/lib/preferences";
import { useApi } from "~/lib/session";
import { SPACE } from "~/lib/theme";

import { BAR_HEIGHT, CollapsedBar } from "./bar";
import { fullOpacity, heightOf, useCollapsingHeader } from "./collapse";
import type { CollapsingHeader } from "./collapse";
import { DEFAULT_FILTERS, FilterBar, filterQuery, ListHeader } from "./filters";
import type { Filters } from "./filters";
import { IssueRow } from "./row";
import { filterSummary } from "./summary";

/** The first page has no cursor. */
const FIRST_PAGE: string | null = null;

function useIssuePages(filters: Filters) {
  const api = useApi();
  const org = useOrg();
  const query = filterQuery(filters);

  return useInfiniteQuery({
    queryKey: ["issues", org, "list", query.toString()],
    queryFn: ({ pageParam }) => {
      const page = new URLSearchParams(query);

      if (pageParam !== null) {
        page.set("cursor", pageParam);
      }

      return api.issues(org, page);
    },
    initialPageParam: FIRST_PAGE,
    getNextPageParam: (last) => last.nextCursor,
  });
}

/**
 * A push or the Projects tab opens the list filtered to a project. `at` makes
 * each of those navigations new, so a second one for the same project applies
 * again after the filters were changed in between.
 */
function useProjectParam(setFilters: (update: (filters: Filters) => Filters) => void): void {
  const { project, at } = useLocalSearchParams<{ project?: string; at?: string }>();

  useEffect(() => {
    // Both come together: every navigation that filters by project sets `at`.
    if (project !== undefined && at !== undefined) {
      setFilters((filters) => ({ ...filters, project: Number(project), status: "unresolved" }));
    }
  }, [project, at, setFilters]);
}

type SelectionBarProps = {
  count: number;
  onStatus: (status: IssueStatus) => void;
  onCancel: () => void;
};

function SelectionBar({ count, onStatus, onCancel }: SelectionBarProps): JSX.Element {
  const palette = usePalette();

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: SPACE.sm,
        paddingHorizontal: SPACE.lg,
        paddingVertical: SPACE.md,
        backgroundColor: palette.bg,
        borderTopColor: palette.border,
        borderTopWidth: 1,
      }}
    >
      <Text weight="medium" tone="heading" style={{ flex: 1 }}>
        {count} selected
      </Text>
      <Button label="Archive" icon="archive" onPress={() => onStatus("ignored")} />
      <Button label="Resolve" kind="primary" icon="check" onPress={() => onStatus("resolved")} />
      <Button label="Clear selection" icon="close" iconOnly onPress={onCancel} />
    </View>
  );
}

type Selection = { selected: Set<number>; toggle: (id: number) => void; clear: () => void };

function useSelection(): Selection {
  const [selected, setSelected] = useState(new Set<number>());

  const toggle = (id: number): void => {
    setSelected((current) => {
      const next = new Set(current);

      if (!next.delete(id)) {
        next.add(id);
      }

      return next;
    });
  };

  return { selected, toggle, clear: () => setSelected(new Set()) };
}

type Pages = ReturnType<typeof useIssuePages>;

type FeedProps = {
  pages: Pages;
  selection: Selection;
  /** The floating header's height, which the first row starts below. */
  top: number;
  onScroll: CollapsingHeader["onScroll"];
};

function IssueFeed({ pages, selection, top, onScroll }: FeedProps): JSX.Element {
  const router = useRouter();
  const setStatus = useSetStatus();
  const now = useNow();
  const issues: ApiIssue[] = pages.data?.pages.flatMap((page) => page.issues) ?? [];
  const selecting = selection.selected.size > 0;

  return (
    <Animated.FlatList
      data={issues}
      onScroll={onScroll}
      scrollEventThrottle={16}
      contentContainerStyle={{ paddingTop: top }}
      keyExtractor={(issue) => String(issue.id)}
      renderItem={({ item }) => (
        <IssueRow
          issue={item}
          now={now}
          selecting={selecting}
          selected={selection.selected.has(item.id)}
          onOpen={() => router.push({ pathname: "/issues/[id]", params: { id: String(item.id) } })}
          onToggle={() => selection.toggle(item.id)}
          onStatus={(status) => setStatus({ ids: [item.id], status })}
        />
      )}
      onEndReached={() => {
        if (pages.hasNextPage && !pages.isFetchingNextPage) {
          void pages.fetchNextPage();
        }
      }}
      onEndReachedThreshold={0.5}
      refreshControl={
        <RefreshControl
          refreshing={pages.isRefetching}
          onRefresh={() => void pages.refetch()}
          // Below the header, not hidden behind it.
          progressViewOffset={top}
        />
      }
      ListEmptyComponent={
        <Notice
          loading={pages.isPending}
          error={pages.error}
          empty="No issues match. Nothing to fix, or try other filters."
          onRetry={() => void pages.refetch()}
        />
      }
      ListFooterComponent={pages.isFetchingNextPage ? <Notice loading error={null} /> : undefined}
    />
  );
}

type FloatingHeaderProps = {
  header: CollapsingHeader;
  filters: Filters;
  onFilters: (filters: Filters) => void;
  projects: UseQueryResult<ApiProject[]>;
  /** The whole header's height, which the list's first row starts below. */
  onHeight: (height: number) => void;
};

/** Title, search, filters and the table header, floating over the list. */
function FloatingHeader(props: FloatingHeaderProps): JSX.Element {
  const { header, filters, onFilters, projects, onHeight } = props;
  const organization = useOrganization();
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const { hidden, range } = header;
  const slide = useAnimatedStyle(() => ({ transform: [{ translateY: -hidden.get() }] }));
  const fade = useAnimatedStyle(() => ({ opacity: fullOpacity(hidden.get(), range.get()) }));

  return (
    <Animated.View
      onLayout={(event) => onHeight(heightOf(event))}
      style={[
        { position: "absolute", top: 0, left: 0, right: 0, backgroundColor: palette.bg },
        slide,
      ]}
    >
      <Animated.View
        // What collapses: all of this but the slim bar's height, so the
        // table header ends up just under the bar. Only the contents fade;
        // the background above stays opaque, so rows never show through.
        onLayout={(event) => header.measure(heightOf(event) - insets.top - BAR_HEIGHT)}
        style={[{ paddingTop: insets.top + SPACE.lg }, fade]}
      >
        <FilterBar
          organization={organization.name}
          filters={filters}
          projects={projects.data ?? []}
          onChange={onFilters}
        />
        {projects.error !== null && (
          // Without the projects, the project dropdown can only offer "All Projects".
          <Text
            tone="danger"
            size={13}
            style={{ paddingHorizontal: SPACE.lg, paddingBottom: SPACE.sm }}
          >
            Could not load projects: {projects.error.message}
          </Text>
        )}
      </Animated.View>
      <ListHeader sort={filters.sort} onSort={(sort) => onFilters({ ...filters, sort })} />
    </Animated.View>
  );
}

function IssueList(): JSX.Element {
  const api = useApi();
  const org = useOrg();
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const pages = useIssuePages(filters);
  const projects = useQuery({ queryKey: ["projects", org], queryFn: () => api.projects(org) });
  const setStatus = useSetStatus();
  const selection = useSelection();
  const header = useCollapsingHeader();
  const [headerHeight, setHeaderHeight] = useState(0);

  useProjectParam(setFilters);

  return (
    <View style={{ flex: 1, backgroundColor: palette.bg }}>
      <IssueFeed
        pages={pages}
        selection={selection}
        top={headerHeight}
        onScroll={header.onScroll}
      />
      <FloatingHeader
        header={header}
        filters={filters}
        onFilters={setFilters}
        projects={projects}
        onHeight={setHeaderHeight}
      />
      {/* Covers the status bar's area, so a half-hidden header slides under it. */}
      <View
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: insets.top,
          backgroundColor: palette.bg,
        }}
      />
      <CollapsedBar
        top={insets.top}
        summary={filterSummary(filters, projects.data ?? [])}
        onOpen={header.open}
        header={header}
      />
      {selection.selected.size > 0 && (
        <SelectionBar
          count={selection.selected.size}
          onCancel={selection.clear}
          onStatus={(status) => {
            setStatus({ ids: [...selection.selected], status });
            selection.clear();
          }}
        />
      )}
    </View>
  );
}

/** Filters and selection belong to one organization; switching starts afresh. */
export function IssueListScreen(): JSX.Element {
  return <IssueList key={useOrg()} />;
}
