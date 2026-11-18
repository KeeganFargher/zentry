// One issue in the list, laid out as a row of Sentry's issue stream: the
// error type with where it happened, the level bar and message, the short ID
// and ages with a state tag, and the trend and event count on the right.
// Swipe right to resolve, left to archive; long-press to start selecting.

import type { ApiIssue, IssueStatus } from "@contract";
import { useRef } from "react";
import type { JSX } from "react";
import { Pressable, View } from "react-native";
import ReanimatedSwipeable from "react-native-gesture-handler/ReanimatedSwipeable";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";

import { LevelBar, stateTone, Tag } from "~/components/basics";
import { MiniBars } from "~/components/charts";
import { Icon } from "~/components/icons";
import type { IconName } from "~/components/icons";
import { Text } from "~/components/text";
import { age, compact, timeAgo } from "~/lib/format";
import { issueMessage, issueTitle, substatus } from "~/lib/issue";
import { usePalette } from "~/lib/preferences";
import type { Palette } from "~/lib/theme";
import { SPACE } from "~/lib/theme";

type RowProps = {
  issue: ApiIssue;
  now: number;
  selecting: boolean;
  selected: boolean;
  onOpen: () => void;
  onToggle: () => void;
  onStatus: (status: IssueStatus) => void;
};

type SwipeAction = {
  status: IssueStatus;
  label: string;
  icon: IconName;
  fill: string;
  ink: string;
};

function SwipePanel({
  action,
  align,
}: {
  action: SwipeAction;
  align: "flex-start" | "flex-end";
}): JSX.Element {
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: action.fill,
        justifyContent: "center",
        alignItems: align,
        paddingHorizontal: SPACE.xl,
      }}
    >
      <View style={{ alignItems: "center", gap: 2 }}>
        <Icon name={action.icon} color={action.ink} size={18} />
        <Text size={12} weight="medium" style={{ color: action.ink }}>
          {action.label}
        </Text>
      </View>
    </View>
  );
}

/** Resolved and archived issues swipe back to unresolved. */
function swipeActions(issue: ApiIssue, palette: Palette): [SwipeAction, SwipeAction] {
  const reopen: SwipeAction = {
    status: "unresolved",
    label: "Reopen",
    icon: "previous",
    fill: palette.accent,
    ink: palette.onAccent,
  };

  return [
    issue.status === "resolved"
      ? reopen
      : {
          status: "resolved",
          label: "Resolve",
          icon: "check",
          fill: palette.okFill,
          ink: palette.onAccent,
        },
    issue.status === "ignored"
      ? reopen
      : {
          status: "ignored",
          label: "Archive",
          icon: "archive",
          // Inverted neutral, so the label keeps its contrast in both themes.
          fill: palette.muted,
          ink: palette.bg,
        },
  ];
}

function TitleLine({ issue }: { issue: ApiIssue }): JSX.Element {
  const palette = usePalette();
  // A message event has no culprit to show beside it: its message line is the culprit.
  const culprit = issue.metadata.type !== null && issue.culprit !== "" ? issue.culprit : null;

  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      {!issue.hasSeen && (
        <View
          accessible
          accessibilityLabel="Unread"
          style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: palette.accent }}
        />
      )}
      <Text lines={1} style={{ flex: 1 }}>
        <Text size={16} tone="heading" weight={issue.hasSeen ? "regular" : "medium"}>
          {issueTitle(issue)}
        </Text>
        {culprit !== null && (
          <Text size={13} tone="muted">
            {"  "}
            {culprit}
          </Text>
        )}
      </Text>
    </View>
  );
}

/** "2wk old"; an issue first seen under a minute ago is just "new". */
function oldness(firstSeen: number, now: number): string {
  const text = age(firstSeen, now);

  return text === "now" ? "new" : `${text} old`;
}

function Summary({ issue, now }: { issue: ApiIssue; now: number }): JSX.Element {
  const message = issueMessage(issue);
  const state = substatus(issue, now);
  // Ongoing carries no tag in the list: it is the state most issues are in.
  const tagged = state !== "Ongoing";

  return (
    <View style={{ flex: 1, gap: 3 }}>
      <TitleLine issue={issue} />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <LevelBar level={issue.level} />
        <Text lines={1} tone={message === null ? "muted" : "text"} style={{ flex: 1 }}>
          {message ?? "(No error message)"}
        </Text>
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <Text size={12} tone="muted" lines={1} style={{ flexShrink: 1 }}>
          {issue.shortId} · {timeAgo(issue.lastSeen, now)} · {oldness(issue.firstSeen, now)}
        </Text>
        {tagged && <Tag label={state} tone={stateTone(state)} />}
      </View>
    </View>
  );
}

function Counts({ issue }: { issue: ApiIssue }): JSX.Element {
  return (
    <View
      style={{ alignItems: "flex-end", gap: 4, width: 64 }}
      accessible
      accessibilityLabel={`${issue.timesSeen} events`}
    >
      <MiniBars points={issue.stats} />
      <Text weight="medium" tone="heading">
        {compact(issue.timesSeen)}
      </Text>
    </View>
  );
}

export function IssueRow(props: RowProps): JSX.Element {
  const { issue, now, selecting, selected, onOpen, onToggle, onStatus } = props;
  const palette = usePalette();
  const swipeable = useRef<SwipeableMethods>(null);
  const [right, left] = swipeActions(issue, palette);

  const opened = (direction: "left" | "right"): void => {
    swipeable.current?.close();
    // The direction is the swipe's, not the side of the panel it reveals:
    // checked on the emulator, a swipe to the right reports "right".
    onStatus(direction === "right" ? right.status : left.status);
  };

  return (
    <ReanimatedSwipeable
      ref={swipeable}
      enabled={!selecting}
      friction={1.5}
      leftThreshold={90}
      rightThreshold={90}
      renderLeftActions={() => <SwipePanel action={right} align="flex-start" />}
      renderRightActions={() => <SwipePanel action={left} align="flex-end" />}
      onSwipeableOpen={opened}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={selecting ? { selected } : undefined}
        accessibilityHint={selecting ? "Selects or clears this issue" : "Opens the issue"}
        onPress={selecting ? onToggle : onOpen}
        onLongPress={onToggle}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "flex-start",
          gap: SPACE.md,
          paddingVertical: SPACE.md,
          paddingHorizontal: SPACE.lg,
          backgroundColor: selected ? palette.accentSoft : pressed ? palette.surface : palette.bg,
          borderBottomColor: palette.borderSoft,
          borderBottomWidth: 1,
        })}
      >
        {selecting && <Checkbox checked={selected} />}
        <Summary issue={issue} now={now} />
        <Counts issue={issue} />
      </Pressable>
    </ReanimatedSwipeable>
  );
}

/** Shown on every row while selecting, so it is clear a tap now selects. */
function Checkbox({ checked }: { checked: boolean }): JSX.Element {
  const palette = usePalette();

  return (
    <View
      style={{
        width: 20,
        height: 20,
        marginTop: 2,
        borderRadius: 4,
        borderWidth: 1,
        borderColor: checked ? palette.accentEdge : palette.border,
        backgroundColor: checked ? palette.accent : palette.bg,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {checked && <Icon name="check" size={14} color={palette.onAccent} />}
    </View>
  );
}
