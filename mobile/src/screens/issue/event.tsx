// One event of the issue, with Sentry's event navigation: oldest, older,
// newer, latest, as a joined button bar beside which event this is. The
// latest is shown first, as on the web.

import type { ApiEventDetail } from "@contract";
import { useQuery } from "@tanstack/react-query";
import type { JSX } from "react";
import { View } from "react-native";

import { Notice } from "~/components/basics";
import { Button, ButtonBar } from "~/components/button";
import { EventBody } from "~/components/event";
import { Text } from "~/components/text";
import { useNow } from "~/lib/clock";
import { timeAgo } from "~/lib/format";
import { useOrg } from "~/lib/organization";
import { usePalette } from "~/lib/preferences";
import { useApi } from "~/lib/session";
import { SPACE } from "~/lib/theme";

/** An event with no newer one is the latest; with no older one, the first. */
function eventName(detail: ApiEventDetail): string {
  if (detail.nextEventId === null) {
    return "Latest event";
  }

  return detail.previousEventId === null ? "Oldest event" : "Event";
}

type NavProps = { detail: ApiEventDetail; onPick: (which: string) => void };

/** Which event this is and when: "Latest event · 12min ago", then its ID, release and environment. */
function EventLabel({ detail }: { detail: ApiEventDetail }): JSX.Element {
  const now = useNow();
  const { event } = detail;

  const details = [event.eventId.slice(0, 8), event.release, event.environment].filter(
    (part) => part !== null,
  );

  return (
    <View style={{ flex: 1, gap: 2 }}>
      <Text size={13}>
        <Text size={13} weight="medium" tone="heading">
          {eventName(detail)}
        </Text>
        {" · "}
        {timeAgo(event.timestamp, now)}
      </Text>
      <Text size={12} tone="muted" selectable>
        {details.join(" · ")}
      </Text>
    </View>
  );
}

/** Oldest, older, newer, latest, as one joined bar. */
function EventStepper({ detail, onPick }: NavProps): JSX.Element {
  const { previousEventId, nextEventId } = detail;

  return (
    <ButtonBar>
      <Button
        label="Oldest event"
        icon="first"
        iconOnly
        join="first"
        disabled={previousEventId === null}
        onPress={() => onPick("oldest")}
      />
      <Button
        label="Older event"
        icon="previous"
        iconOnly
        join="middle"
        disabled={previousEventId === null}
        onPress={() => {
          // Disabled without an id, so a press without one is a bug.
          if (previousEventId === null) {
            throw new Error("No older event to show");
          }

          onPick(previousEventId);
        }}
      />
      <Button
        label="Newer event"
        icon="next"
        iconOnly
        join="middle"
        disabled={nextEventId === null}
        onPress={() => {
          if (nextEventId === null) {
            throw new Error("No newer event to show");
          }

          onPick(nextEventId);
        }}
      />
      <Button
        label="Latest event"
        icon="last"
        iconOnly
        join="last"
        disabled={nextEventId === null}
        onPress={() => onPick("latest")}
      />
    </ButtonBar>
  );
}

function EventNav({ detail, onPick }: NavProps): JSX.Element {
  const palette = usePalette();

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: SPACE.md,
        padding: SPACE.lg,
        borderBottomWidth: 1,
        borderBottomColor: palette.borderSoft,
      }}
    >
      <EventLabel detail={detail} />
      <EventStepper detail={detail} onPick={onPick} />
    </View>
  );
}

type PanelProps = { issueId: number; which: string; onPick: (which: string) => void };

export function EventPanel({ issueId, which, onPick }: PanelProps): JSX.Element {
  const api = useApi();
  const org = useOrg();

  const detail = useQuery({
    queryKey: ["issues", org, issueId, "event", which],
    queryFn: () => api.event(org, issueId, which),
  });

  if (detail.data === undefined) {
    return (
      <Notice
        loading={detail.isPending}
        error={detail.error}
        onRetry={() => void detail.refetch()}
      />
    );
  }

  return (
    <View>
      <EventNav detail={detail.data} onPick={onPick} />
      <EventBody event={detail.data.event} />
    </View>
  );
}
