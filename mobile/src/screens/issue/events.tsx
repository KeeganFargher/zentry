// Every stored event of an issue, newest first, as the web "All events" tab.
// A tap shows that event on the issue screen.

import type { ApiEventRow } from "@contract";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useLocalSearchParams, useRouter } from "expo-router";
import type { JSX } from "react";
import { FlatList, Pressable, RefreshControl, View } from "react-native";

import { Notice } from "~/components/basics";
import { Text } from "~/components/text";
import { useNow } from "~/lib/clock";
import { timeAgo } from "~/lib/format";
import { useOrg } from "~/lib/organization";
import { usePalette } from "~/lib/preferences";
import { usePullRefresh } from "~/lib/pull-refresh";
import { useApi } from "~/lib/session";
import { SPACE } from "~/lib/theme";

/** The first page has no cursor. */
const FIRST_PAGE: string | null = null;

function EventRow({
  event,
  issueId,
  now,
}: {
  event: ApiEventRow;
  issueId: number;
  now: number;
}): JSX.Element {
  const router = useRouter();
  const palette = usePalette();

  return (
    <Pressable
      onPress={() =>
        router.dismissTo({
          pathname: "/issues/[id]",
          params: { id: String(issueId), event: event.eventId },
        })
      }
      style={({ pressed }) => ({
        padding: SPACE.md,
        gap: 2,
        backgroundColor: pressed ? palette.raised : palette.bg,
        borderBottomColor: palette.borderSoft,
        borderBottomWidth: 1,
      })}
    >
      <View style={{ flexDirection: "row", justifyContent: "space-between", gap: SPACE.md }}>
        <Text mono size={12} lines={1} style={{ flexShrink: 1 }}>
          {event.eventId.slice(0, 12)}
        </Text>
        <Text size={12} tone="muted">
          {timeAgo(event.timestamp, now)}
        </Text>
      </View>
      {event.title !== null && (
        <Text size={13} lines={2}>
          {event.title}
        </Text>
      )}
      <Text size={12} tone="muted" lines={1}>
        {[event.environment, event.release, event.user].filter((part) => part !== null).join(" · ")}
      </Text>
    </Pressable>
  );
}

export function EventsScreen(): JSX.Element {
  const api = useApi();
  const org = useOrg();
  const now = useNow();
  const issueId = Number(useLocalSearchParams<{ id: string }>().id);

  const pages = useInfiniteQuery({
    queryKey: ["issues", org, issueId, "events"],
    queryFn: ({ pageParam }) =>
      pageParam === null ? api.events(org, issueId) : api.eventsAfter(org, issueId, pageParam),
    initialPageParam: FIRST_PAGE,
    getNextPageParam: (last) => last.nextCursor,
  });

  const events = pages.data?.pages.flatMap((page) => page.events) ?? [];

  const pull = usePullRefresh(async () => {
    await pages.refetch();
  });

  return (
    <FlatList
      data={events}
      keyExtractor={(event) => event.eventId}
      renderItem={({ item }) => <EventRow event={item} issueId={issueId} now={now} />}
      onEndReached={() => {
        if (pages.hasNextPage && !pages.isFetchingNextPage) {
          void pages.fetchNextPage();
        }
      }}
      refreshControl={<RefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />}
      ListEmptyComponent={
        <Notice loading={pages.isPending} error={pages.error} empty="No stored events." />
      }
    />
  );
}
