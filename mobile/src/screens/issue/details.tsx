// The issue's tag breakdown and activity, as flat blocks under the issue
// page's tabs, the way Sentry's tag distribution and activity read.

import type { ApiActivity, ApiIssue, ApiTag } from "@contract";
import { useState } from "react";
import type { JSX, ReactNode } from "react";
import { Pressable, View } from "react-native";

import { Heading, Text } from "~/components/text";
import { longAgo, share } from "~/lib/format";
import { usePalette } from "~/lib/preferences";
import { SPACE } from "~/lib/theme";

const TOP_VALUES = 5;

function TagCard({ tag }: { tag: ApiTag }): JSX.Element {
  const palette = usePalette();

  return (
    <View style={{ gap: 6 }}>
      <Text weight="medium" tone="heading">
        {tag.key}
      </Text>
      {tag.values.slice(0, TOP_VALUES).map((value) => (
        <View key={value.value} style={{ gap: 2 }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between", gap: SPACE.md }}>
            <Text size={13} lines={1} style={{ flexShrink: 1 }} selectable>
              {value.value}
            </Text>
            <Text size={13} tone="muted">
              {share(value.count, tag.total)}
            </Text>
          </View>
          <View style={{ height: 6, borderRadius: 3, backgroundColor: palette.raised }}>
            <View
              style={{
                height: 6,
                borderRadius: 3,
                width: `${tag.total === 0 ? 0 : (value.count / tag.total) * 100}%`,
                backgroundColor: palette.accent,
              }}
            />
          </View>
        </View>
      ))}
    </View>
  );
}

function Block({ children }: { children: ReactNode }): JSX.Element {
  return <View style={{ padding: SPACE.lg, gap: SPACE.lg }}>{children}</View>;
}

export function IssueTags({ tags }: { tags: ApiTag[] }): JSX.Element {
  return (
    <Block>
      <Heading>Tags</Heading>
      {tags.length === 0 ? (
        <Text tone="muted">No tags on this issue's events.</Text>
      ) : (
        tags.map((tag) => <TagCard key={tag.key} tag={tag} />)
      )}
    </Block>
  );
}

const ACTIVITY_LABELS = new Map([
  ["resolved", "Resolved"],
  ["unresolved", "Marked as unresolved"],
  ["ignored", "Archived"],
  ["regressed", "Regressed"],
]);

/** Five or more entries fold down to the newest three, as on the web and Sentry. */
const FOLD_AT = 5;
const FOLDED = 3;

type ActivityProps = { issue: ApiIssue; entries: ApiActivity[]; now: number };

export function IssueActivity({ issue, entries, now }: ActivityProps): JSX.Element {
  const [all, setAll] = useState(false);
  const fold = !all && entries.length + 1 >= FOLD_AT;
  const shown = fold ? entries.slice(0, FOLDED) : entries;

  return (
    <Block>
      <Heading>Activity</Heading>
      {shown.map((entry) => (
        <View key={entry.id}>
          <Text weight="medium" tone="heading">
            {ACTIVITY_LABELS.get(entry.type) ?? entry.type}
            {entry.userEmail !== null && <Text tone="muted"> by {entry.userEmail}</Text>}
          </Text>
          <Text size={12} tone="muted">
            {longAgo(entry.createdAt, now)}
          </Text>
        </View>
      ))}
      {fold ? (
        <Pressable accessibilityRole="button" onPress={() => setAll(true)} hitSlop={SPACE.md}>
          <Text tone="link">View {entries.length + 1 - shown.length} more</Text>
        </Pressable>
      ) : (
        <View>
          <Text weight="medium" tone="heading">
            First seen
          </Text>
          <Text size={12} tone="muted">
            {longAgo(issue.firstSeen, now)}
          </Text>
        </View>
      )}
    </Block>
  );
}
