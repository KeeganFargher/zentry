// One issue, laid out as Sentry's issue page: breadcrumb, header, actions,
// the events chart, then tabs for the event itself, its tags or its activity.
// Opening it marks it seen, as opening it on the web does.

import type { ApiIssue } from "@contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { Pressable, RefreshControl, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Notice } from "~/components/basics";
import { BarChart } from "~/components/charts";
import { Segmented } from "~/components/segmented";
import { Tabs } from "~/components/tabs";
import { Heading, Text } from "~/components/text";
import type { StatsPeriod } from "~/lib/api";
import { useNow } from "~/lib/clock";
import { timeAgo } from "~/lib/format";
import { toast } from "~/lib/issue-actions";
import { useOrg } from "~/lib/organization";
import { usePalette } from "~/lib/preferences";
import { useApi } from "~/lib/session";
import { CONTROL, SPACE } from "~/lib/theme";

import { IssueActions } from "./actions";
import { IssueActivity, IssueTags } from "./details";
import { EventPanel } from "./event";
import { BackCrumb, Crumbs, IssueHeader } from "./header";

type Tab = "event" | "tags" | "activity";

const TABS: [Tab, string][] = [
  ["event", "Event"],
  ["tags", "Tags"],
  ["activity", "Activity"],
];

const PERIODS: [StatsPeriod, string][] = [
  ["24h", "24H"],
  ["14d", "14D"],
  ["30d", "30D"],
];

const HOUR = 60 * 60 * 1000;
const STEPS: Record<StatsPeriod, number> = { "24h": HOUR, "14d": 24 * HOUR, "30d": 24 * HOUR };

function Graph({ issue, now }: { issue: ApiIssue; now: number }): JSX.Element {
  const api = useApi();
  const org = useOrg();
  const palette = usePalette();
  const [period, setPeriod] = useState<StatsPeriod>("24h");

  const stats = useQuery({
    queryKey: ["issues", org, issue.id, "stats", period],
    queryFn: () => api.stats(org, issue.id, period),
  });

  return (
    <View
      style={{
        padding: SPACE.lg,
        gap: SPACE.md,
        borderBottomWidth: 1,
        borderBottomColor: palette.borderSoft,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Heading>Events</Heading>
        <Segmented label="Chart period" options={PERIODS} value={period} onChange={setPeriod} />
      </View>
      {stats.data === undefined ? (
        <Notice
          loading={stats.isPending}
          error={stats.error}
          onRetry={() => void stats.refetch()}
        />
      ) : (
        <BarChart
          points={stats.data.points}
          step={STEPS[period]}
          start={`${period} ago`}
          summary={`Last seen ${timeAgo(issue.lastSeen, now)} · first seen ${timeAgo(issue.firstSeen, now)}`}
        />
      )}
    </View>
  );
}

function TagsTab({ issueId }: { issueId: number }): JSX.Element {
  const api = useApi();
  const org = useOrg();

  const tags = useQuery({
    queryKey: ["issues", org, issueId, "tags"],
    queryFn: () => api.tags(org, issueId),
  });

  return tags.data === undefined ? (
    <Notice loading={tags.isPending} error={tags.error} onRetry={() => void tags.refetch()} />
  ) : (
    <IssueTags tags={tags.data} />
  );
}

function ActivityTab({ issue }: { issue: ApiIssue }): JSX.Element {
  const api = useApi();
  const org = useOrg();
  const now = useNow();

  const activity = useQuery({
    queryKey: ["issues", org, issue.id, "activity"],
    queryFn: () => api.activity(org, issue.id),
  });

  return activity.data === undefined ? (
    <Notice
      loading={activity.isPending}
      error={activity.error}
      onRetry={() => void activity.refetch()}
    />
  ) : (
    <IssueActivity issue={issue} entries={activity.data} now={now} />
  );
}

/** Marks the issue seen once it is open, so the list stops showing it as unread. */
function useMarkSeen(issue: ApiIssue | undefined): void {
  const api = useApi();
  const org = useOrg();
  const queries = useQueryClient();
  const unseen = issue !== undefined && !issue.hasSeen;
  const id = issue?.id;

  useEffect(() => {
    if (unseen && id !== undefined) {
      api
        .markSeen(org, id)
        .then(() => queries.invalidateQueries({ queryKey: ["issues", org] }))
        .catch((cause: unknown) =>
          toast(cause instanceof Error ? cause.message : "Could not mark the issue seen"),
        );
    }
  }, [api, org, queries, unseen, id]);
}

/** Which tab and event are shown, for the event the screen was opened with. */
type Shown = { opened: string | undefined; tab: Tab; which: string };

/**
 * Picking an event in the events list comes back here with its id, which
 * starts a new view on that event; choices made since apply until then.
 */
function useView(opened: string | undefined): [Shown, (change: Partial<Shown>) => void] {
  const fresh: Shown = { opened, tab: "event", which: opened ?? "latest" };
  const [view, setView] = useState(fresh);
  const current = view.opened === opened ? view : fresh;

  return [current, (change) => setView({ ...current, ...change })];
}

/** Sentry's link from the tab row to every event of the issue. */
function AllEventsLink({ issueId }: { issueId: number }): JSX.Element {
  const router = useRouter();

  return (
    <Pressable
      accessibilityRole="link"
      onPress={() =>
        router.push({ pathname: "/issues/[id]/events", params: { id: String(issueId) } })
      }
      style={{ height: CONTROL.touch, justifyContent: "center", paddingHorizontal: SPACE.xs }}
    >
      <Text tone="link">All Events</Text>
    </Pressable>
  );
}

/**
 * Every query on the page (event, chart, tags, activity, follow) is keyed
 * under the issue, so refreshing invalidates the lot, not just the header.
 */
function useRefresh(issueId: number): [boolean, () => Promise<void>] {
  const org = useOrg();
  const queries = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);

  const refresh = async (): Promise<void> => {
    setRefreshing(true);

    try {
      await queries.invalidateQueries({ queryKey: ["issues", org, issueId] });
    } finally {
      setRefreshing(false);
    }
  };

  return [refreshing, refresh];
}

export function IssueScreen(): JSX.Element {
  const api = useApi();
  const org = useOrg();
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ id: string; event?: string }>();
  const issueId = Number(params.id);
  const now = useNow();
  const [view, setView] = useView(params.event);

  const issue = useQuery({
    queryKey: ["issues", org, issueId],
    queryFn: () => api.issue(org, issueId),
  });

  useMarkSeen(issue.data);

  const [refreshing, refresh] = useRefresh(issueId);

  const page = { flex: 1, backgroundColor: palette.bg, paddingTop: insets.top };

  if (issue.data === undefined) {
    return (
      <View style={page}>
        <BackCrumb />
        <Notice
          loading={issue.isPending}
          error={issue.error}
          onRetry={() => void issue.refetch()}
        />
      </View>
    );
  }

  // The inset pads a view around the scroller: padding on the scroller itself
  // would scroll away and let the content run under the status bar.
  return (
    <View style={page}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + SPACE.xl }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
      >
        <Crumbs shortId={issue.data.shortId} />
        <IssueHeader issue={issue.data} now={now} />
        <IssueActions issue={issue.data} />
        <Graph issue={issue.data} now={now} />
        <Tabs
          tabs={TABS}
          value={view.tab}
          onChange={(tab) => setView({ tab })}
          trailing={<AllEventsLink issueId={issueId} />}
        />
        {view.tab === "event" && (
          <EventPanel issueId={issueId} which={view.which} onPick={(which) => setView({ which })} />
        )}
        {view.tab === "tags" && <TagsTab issueId={issueId} />}
        {view.tab === "activity" && <ActivityTab issue={issue.data} />}
      </ScrollView>
    </View>
  );
}
