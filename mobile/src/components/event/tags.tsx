// The Tags section: the web's tag list (ui/src/pages/event-tags.tsx) as
// wrapping key:value chips, with the same filter tabs. The web's per-value
// menu becomes a long press that copies the value; searching issues by a tag
// belongs to the issue list's filters in the app.

import type { StoredEvent } from "@contract";
import { useState } from "react";
import type { JSX } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { Segmented } from "~/components/segmented";
import { Text } from "~/components/text";
import { usePalette } from "~/lib/preferences";
import { RADIUS, SPACE } from "~/lib/theme";

import { copyText } from "./copy";
import { EventSection } from "./parts";
import { eventTags, inTab, TABS } from "./tag-model";
import type { Tab } from "./tag-model";

const styles = StyleSheet.create({
  chips: { flexDirection: "row", flexWrap: "wrap", gap: SPACE.xs },
  chip: {
    flexDirection: "row",
    maxWidth: "100%",
    borderWidth: 1,
    borderRadius: RADIUS.md,
    overflow: "hidden",
  },
  key: { paddingHorizontal: SPACE.sm, paddingVertical: 3 },
  value: { paddingHorizontal: SPACE.sm, paddingVertical: 3, flexShrink: 1 },
});

function Chip({ name, value }: { name: string; value: string }): JSX.Element {
  const palette = usePalette();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint="Long press to copy the value"
      onLongPress={() => void copyText(value)}
      style={({ pressed }) => [
        styles.chip,
        { borderColor: palette.border, opacity: pressed ? 0.75 : 1 },
      ]}
    >
      <View style={[styles.key, { backgroundColor: palette.surface }]}>
        <Text size={12} tone="muted">
          {name}
        </Text>
      </View>
      <View style={styles.value}>
        <Text size={12}>{value}</Text>
      </View>
    </Pressable>
  );
}

export function TagsSection({ event }: { event: StoredEvent }): JSX.Element {
  const [tab, setTab] = useState<Tab>("all");
  const own = new Set(event.tags.map(([key]) => key));
  const tags = eventTags(event);

  const available = TABS.filter(
    ([option]) => option === "all" || tags.some(([key]) => inTab(option, key, own)),
  );

  const shown = tags.filter(([key]) => inTab(tab, key, own));

  return (
    <EventSection
      title="Tags"
      actions={<Segmented label="Tag groups" options={available} value={tab} onChange={setTab} />}
    >
      <View style={styles.chips}>
        {shown.map(([name, value]) => (
          <Chip key={name} name={name} value={value} />
        ))}
      </View>
    </EventSection>
  );
}
