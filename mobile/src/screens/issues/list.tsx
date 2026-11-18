// The issue list, as Sentry's issue stream: the page header with search and
// filters, a table header that holds the sort, then the rows, more as you
// scroll. Pull down to refresh. A long-press starts selecting, for resolving
// or archiving many at once.

import type { ApiIssue, IssueStatus } from "@contract";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { FlatList, RefreshControl, View } from "react-native";
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

import { DEFAULT_FILTERS, FilterBar, filterQuery, ListHeader } from "./filters";
import type { Filters } from "./filters";
import { IssueRow } from "./row";

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

function IssueFeed({ pages, selection }: { pages: Pages; selection: Selection }): JSX.Element {
  const router = useRouter();
  const setStatus = useSetStatus();
  const now = useNow();
  const issues: ApiIssue[] = pages.data?.pages.flatMap((page) => page.issues) ?? [];
  const selecting = selection.selected.size > 0;

  return (
    <FlatList
      data={issues}
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
        <RefreshControl refreshing={pages.isRefetching} onRefresh={() => void pages.refetch()} />
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

function IssueList(): JSX.Element {
  const api = useApi();
  const org = useOrg();
  const organization = useOrganization();
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const pages = useIssuePages(filters);
  const projects = useQuery({ queryKey: ["projects", org], queryFn: () => api.projects(org) });
  const setStatus = useSetStatus();
  const selection = useSelection();

  useProjectParam(setFilters);

  return (
    <View style={{ flex: 1, backgroundColor: palette.bg, paddingTop: insets.top + SPACE.lg }}>
      <FilterBar
        organization={organization.name}
        filters={filters}
        projects={projects.data ?? []}
        onChange={setFilters}
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
      <ListHeader sort={filters.sort} onSort={(sort) => setFilters({ ...filters, sort })} />
      <IssueFeed pages={pages} selection={selection} />
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
