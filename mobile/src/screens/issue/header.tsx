// The top of the issue page, as Sentry's issue header: a breadcrumb back to
// the list, then what the error is, how often it happens, its state, where
// it was thrown and in which project.

import type { ApiIssue } from "@contract";
import { useRouter } from "expo-router";
import type { JSX, ReactNode } from "react";
import { Pressable, View } from "react-native";

import { LevelBar, stateTone, Tag } from "~/components/basics";
import type { TagTone } from "~/components/basics";
import { copyText } from "~/components/event/copy";
import { Icon } from "~/components/icons";
import { Text } from "~/components/text";
import { compact } from "~/lib/format";
import { issueMessage, issueTitle, substatus } from "~/lib/issue";
import { toast } from "~/lib/issue-actions";
import { usePalette } from "~/lib/preferences";
import { CONTROL, SPACE } from "~/lib/theme";

/** "‹ Issues": the whole breadcrumb while the issue is loading. */
export function BackCrumb({ children }: { children?: ReactNode }): JSX.Element {
  const router = useRouter();
  const palette = usePalette();

  return (
    <View style={{ flexDirection: "row", alignItems: "center", height: 48, paddingHorizontal: 2 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Back to issues"
        onPress={() => router.back()}
        style={{
          width: CONTROL.touch,
          height: CONTROL.touch,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon name="previous" color={palette.heading} />
      </Pressable>
      <Text tone="muted">Issues</Text>
      {children}
    </View>
  );
}

/** "‹ Issues › SHOP-WEB-1". Tapping the short ID copies it, for pasting into a ticket. */
export function Crumbs({ shortId }: { shortId: string }): JSX.Element {
  return (
    <BackCrumb>
      <View style={{ paddingHorizontal: 4 }}>
        <Icon name="next" size={12} />
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Copy short ID ${shortId}`}
        onPress={() => void copyText(shortId).then(() => toast(`Copied ${shortId}`))}
        style={{
          height: CONTROL.touch,
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          paddingHorizontal: 4,
        }}
      >
        <Text tone="heading">{shortId}</Text>
        <Icon name="copy" size={14} />
      </Pressable>
    </BackCrumb>
  );
}

/**
 * The state tag beside where it was thrown, then the project and first
 * release on their own line: as one wrapping row, a divider could end a line.
 */
function Facts({
  issue,
  state,
  tone,
}: {
  issue: ApiIssue;
  state: string;
  tone: TagTone;
}): JSX.Element {
  const culprit = issue.metadata.type !== null && issue.culprit !== "" ? issue.culprit : null;
  const where = [issue.projectSlug];

  if (issue.firstRelease !== null) {
    where.push(`first seen in ${issue.firstRelease}`);
  }

  return (
    <View style={{ gap: 4 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: SPACE.sm }}>
        <Tag label={state} tone={tone} />
        {culprit !== null && (
          <Text size={12} mono tone="muted" selectable lines={1} style={{ flexShrink: 1 }}>
            {culprit}
          </Text>
        )}
      </View>
      <Text size={13} tone="muted">
        {where.join(" · ")}
      </Text>
    </View>
  );
}

export function IssueHeader({ issue, now }: { issue: ApiIssue; now: number }): JSX.Element {
  const message = issueMessage(issue);
  const state = substatus(issue, now);
  const tone = stateTone(state);

  return (
    <View style={{ paddingHorizontal: SPACE.lg, gap: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: SPACE.md }}>
        <Text size={24} weight="medium" tone="heading" selectable style={{ flex: 1 }}>
          {issueTitle(issue)}
        </Text>
        <View
          style={{ alignItems: "flex-end" }}
          accessible
          accessibilityLabel={`${issue.timesSeen} events`}
        >
          <Text size={12} tone="muted">
            Events
          </Text>
          <Text size={20} tone="heading">
            {compact(issue.timesSeen)}
          </Text>
        </View>
      </View>
      {message !== null && (
        <View style={{ flexDirection: "row", gap: 6, alignItems: "flex-start" }}>
          <View style={{ paddingTop: 3 }}>
            <LevelBar level={issue.level} />
          </View>
          <Text selectable style={{ flex: 1 }}>
            {message}
          </Text>
        </View>
      )}
      <Facts issue={issue} state={state} tone={tone} />
    </View>
  );
}
