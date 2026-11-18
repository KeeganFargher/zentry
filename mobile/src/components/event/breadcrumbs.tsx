// The Breadcrumbs section, ported from ui/src/pages/breadcrumbs.tsx: a
// timeline of what happened before the event, newest first, starting with
// the event itself.

import type { StoredBreadcrumb, StoredEvent } from "@contract";
import { useState } from "react";
import type { JSX } from "react";
import { StyleSheet, TextInput } from "react-native";

import { Segmented } from "~/components/segmented";
import { Text } from "~/components/text";
import { clockTime } from "~/lib/format";
import { usePalette } from "~/lib/preferences";
import { FONTS, RADIUS, SPACE } from "~/lib/theme";

import { Breadcrumb } from "./crumb";
import { matches, relative, thisEvent } from "./crumb-model";
import type { Crumb } from "./crumb-model";
import { numbered } from "./lists";
import { EventSection, LinkButton } from "./parts";

/**
 * How many show before "Show all", the event itself included. The web shows
 * six beside a wide stack trace; a phone scrolls, so ten fit the screen.
 */
const SUMMARY = 10;

const TIMES = [
  ["absolute", "Absolute"],
  ["relative", "Relative"],
] as const;

const styles = StyleSheet.create({
  search: {
    flexGrow: 1,
    borderWidth: 1,
    borderRadius: RADIUS.md,
    paddingHorizontal: SPACE.sm,
    paddingVertical: 5,
    fontFamily: FONTS.regular,
    fontSize: 13,
  },
});

type Times = (typeof TIMES)[number][0];

function timeOf(crumb: Crumb, times: Times, eventTime: number): string {
  if (crumb.timestamp === null) {
    return "";
  }

  return times === "relative" ? relative(crumb.timestamp, eventTime) : clockTime(crumb.timestamp);
}

function real(crumb: StoredBreadcrumb): Crumb {
  return { ...crumb, virtual: false };
}

function Search({
  value,
  onChange,
}: {
  value: string;
  onChange: (text: string) => void;
}): JSX.Element {
  const palette = usePalette();

  return (
    <TextInput
      value={value}
      onChangeText={onChange}
      placeholder="Filter breadcrumbs…"
      placeholderTextColor={palette.faint}
      accessibilityLabel="Filter breadcrumbs"
      style={[styles.search, { borderColor: palette.border, color: palette.text }]}
    />
  );
}

export function Breadcrumbs({ event }: { event: StoredEvent }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [search, setSearch] = useState("");
  const [times, setTimes] = useState<Times>("absolute");
  // Numbered before filtering, so a crumb keeps its key (and its open data)
  // as the filter changes what is shown.
  const timeline = numbered([thisEvent(event), ...event.breadcrumbs.toReversed().map(real)]);
  const all = timeline.filter(([, crumb]) => matches(crumb, search));
  // One hidden crumb isn't worth a button: show it instead.
  const limit = all.length === SUMMARY + 1 ? all.length : SUMMARY;
  const shown = expanded || search !== "" ? all : all.slice(0, limit);

  const actions = (
    <>
      <Search value={search} onChange={setSearch} />
      <Segmented label="Time format" options={TIMES} value={times} onChange={setTimes} />
    </>
  );

  return (
    <EventSection title="Breadcrumbs" actions={actions}>
      {shown.map(([index, crumb]) => (
        <Breadcrumb key={index} crumb={crumb} time={timeOf(crumb, times, event.timestamp)} />
      ))}
      {shown.length === 0 && (
        <Text size={13} tone="muted">
          No breadcrumbs match.
        </Text>
      )}
      {shown.length < all.length && (
        <LinkButton label={`Show all ${all.length}`} onPress={() => setExpanded(true)} />
      )}
    </EventSection>
  );
}
