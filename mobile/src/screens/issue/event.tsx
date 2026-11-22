// One event of the issue, with Sentry's event navigation: oldest, older,
// newer, latest, as a joined button bar beside which event this is. The
// latest is shown first, as on the web. Below it, the web's "Copy as
// Markdown": the whole event as one report, to hand to an AI assistant or
// paste into a ticket.

import type { ApiEventDetail, ApiIssue } from "@contract";
import { useQuery } from "@tanstack/react-query";
import type { JSX } from "react";
import { View } from "react-native";

import { Notice } from "~/components/basics";
import { Button, ButtonBar } from "~/components/button";
import { EventBody } from "~/components/event";
import { copyText } from "~/components/event/copy";
import { Text } from "~/components/text";
import { useNow } from "~/lib/clock";
import { timeAgo } from "~/lib/format";
import { toast } from "~/lib/issue-actions";
import { issueMarkdown } from "~/lib/markdown";
import { useOrg } from "~/lib/organization";
import { usePalette } from "~/lib/preferences";
import { eventQuery } from "~/lib/queries";
import { useApi, useSession } from "~/lib/session";
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

/**
 * Copies the event shown, not the latest: paging to an older event and
 * copying it is how a reader hands over the one that looks different.
 * The link is to the web UI, which the paired server also serves.
 */
function CopyMarkdown({ issue, detail }: { issue: ApiIssue; detail: ApiEventDetail }): JSX.Element {
  const org = useOrg();
  const { session } = useSession();

  if (session === null) {
    throw new Error("Issue shown while signed out");
  }

  const copy = async (): Promise<void> => {
    const link = `${session.apiUrl}/${org}/issues/${issue.id}/`;

    await copyText(issueMarkdown(link, issue, detail.event));
    toast("Copied the issue as Markdown");
  };

  return (
    <View style={{ paddingHorizontal: SPACE.lg, paddingTop: SPACE.md }}>
      <Button label="Copy as Markdown" icon="copy" onPress={() => void copy()} />
    </View>
  );
}

type PanelProps = { issue: ApiIssue; which: string; onPick: (which: string) => void };

export function EventPanel({ issue, which, onPick }: PanelProps): JSX.Element {
  const api = useApi();
  const org = useOrg();

  const detail = useQuery(eventQuery(api, { org, issueId: issue.id }, which));

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
      <CopyMarkdown issue={issue} detail={detail.data} />
      <EventBody event={detail.data.event} />
    </View>
  );
}
