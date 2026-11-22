// The issue list, as Sentry's issue stream: the page header with search and
// filters, a table header that holds the sort, then the rows, more as you
// scroll. The header floats over the list and collapses into a slim bar as
// it scrolls down (collapse.ts), coming back on the way up. Pull down to
// refresh. A long-press starts selecting, for resolving or archiving many.

import type { ApiIssue, IssueStatus } from "@contract";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import type { JSX, RefObject } from "react";
import { RefreshControl, View } from "react-native";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Notice } from "~/components/basics";
import { Button } from "~/components/button";
import { Text } from "~/components/text";
import { useNow } from "~/lib/clock";
import { useSetStatus } from "~/lib/issue-actions";
import { useOrg } from "~/lib/organization";
import { usePalette } from "~/lib/preferences";
import { usePullRefresh } from "~/lib/pull-refresh";
import { issueListQuery, projectsQuery } from "~/lib/queries";
import { useApi } from "~/lib/session";
import { SPACE } from "~/lib/theme";

import { CollapsedBar } from "./bar";
import { useCollapsingHeader } from "./collapse";
import type { CollapsingHeader } from "./collapse";
import { DEFAULT_FILTERS, filterQuery } from "./filters";
import type { Filters } from "./filters";
import { FloatingHeader, useTitleMetrics } from "./header";
import type { SearchInput } from "./header";
import { IssueRow } from "./row";
import { filterSummary } from "./summary";

function useIssuePages(filters: Filters) {
  return useInfiniteQuery(issueListQuery(useApi(), useOrg(), filterQuery(filters)));
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

  const pull = usePullRefresh(async () => {
    await pages.refetch();
  });

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
          refreshing={pull.refreshing}
          onRefresh={pull.onRefresh}
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

/** Covers the status bar's area, so a half-hidden header slides under it. */
function StatusBarBacking({ height }: { height: number }): JSX.Element {
  const palette = usePalette();

  return (
    <View
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        height,
        backgroundColor: palette.bg,
      }}
    />
  );
}

function focusSearch(searchRef: RefObject<SearchInput | null>): void {
  // The field is always mounted in the header, so a missing ref is a bug
  // worth hearing about, not a tap to drop quietly.
  if (searchRef.current === null) {
    throw new Error("The search field is not mounted");
  }

  searchRef.current.focus();
}

function IssueList(): JSX.Element {
  const api = useApi();
  const org = useOrg();
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const pages = useIssuePages(filters);
  const projects = useQuery(projectsQuery(api, org));
  const setStatus = useSetStatus();
  const selection = useSelection();
  const header = useCollapsingHeader();
  const metrics = useTitleMetrics();
  const searchRef = useRef<SearchInput>(null);
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
        metrics={metrics}
        searchRef={searchRef}
        filters={filters}
        onFilters={setFilters}
        projects={projects}
        onHeight={setHeaderHeight}
      />
      <StatusBarBacking height={insets.top} />
      <CollapsedBar
        top={insets.top}
        summary={filterSummary(filters, projects.data ?? [])}
        header={header}
        metrics={metrics}
        onOpen={() => header.openThen(() => {})}
        onSearch={() => header.openThen(() => focusSearch(searchRef))}
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
