// One breadcrumb in the timeline: its type in colour, level, time, message,
// and its data, one line until tapped open.

import type { JsonObject } from "@contract";
import { useState } from "react";
import type { JSX } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { levelTone, Tag } from "~/components/basics";
import { Text } from "~/components/text";
import { usePalette } from "~/lib/preferences";
import { SPACE } from "~/lib/theme";
import type { Palette } from "~/lib/theme";

import { dataOf, titleOf, toneOf, typeOf } from "./crumb-model";
import type { Crumb, CrumbTone } from "./crumb-model";
import { getText, jsonText } from "./json";
import { JsonValue } from "./json-view";

const styles = StyleSheet.create({
  crumb: { flexDirection: "row", gap: SPACE.sm, paddingVertical: SPACE.sm, borderTopWidth: 1 },
  stripe: { width: 3, borderRadius: 2 },
  main: { flex: 1, gap: 2 },
  head: { flexDirection: "row", alignItems: "center", gap: SPACE.sm },
  title: { flexShrink: 1 },
  spacer: { flex: 1 },
});

function HttpLine({ data }: { data: JsonObject }): JSX.Element {
  const status = getText(data, "status_code");

  return (
    <Text size={13} selectable>
      {getText(data, "method") ?? "GET"}: {getText(data, "url") ?? ""}
      {status === null ? "" : ` [${status}]`}
    </Text>
  );
}

/**
 * One line of data until tapped, then the whole tree. The tree sits outside
 * the touchable: its values are selectable, which on Android eats taps.
 */
function CrumbData({ data }: { data: JsonObject }): JSX.Element {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityHint="Shows the breadcrumb's data"
        onPress={() => setOpen(!open)}
        hitSlop={SPACE.xs}
      >
        <Text size={12} tone="muted" mono lines={1}>
          {open ? "▾" : "▸"} {jsonText(data)}
        </Text>
      </Pressable>
      {open && <JsonValue value={data} depth={0} />}
    </>
  );
}

function Details({ crumb, type }: { crumb: Crumb; type: string }): JSX.Element {
  if (type === "http" && crumb.data !== null) {
    return <HttpLine data={crumb.data} />;
  }

  const rest = crumb.data === null ? null : dataOf(crumb.data);

  return (
    <>
      {crumb.message !== null && (
        <Text size={13} selectable>
          {crumb.message}
        </Text>
      )}
      {rest !== null && <CrumbData data={rest} />}
    </>
  );
}

/**
 * The stripe takes the type's fill colour; the title needs a text colour of
 * the same hue, since Sentry's warning and error fills are unreadable as text.
 */
const TITLE_INK: Record<CrumbTone, keyof Palette> = {
  error: "danger",
  warning: "warningText",
  ok: "ok",
  info: "link",
  literal: "link",
  debug: "muted",
};

export function Breadcrumb({ crumb, time }: { crumb: Crumb; time: string }): JSX.Element {
  const palette = usePalette();
  const type = typeOf(crumb);
  const kind = toneOf(type);
  const tone = palette[kind];
  const level = crumb.level === "info" ? null : crumb.level;

  return (
    <View
      style={[
        styles.crumb,
        { borderTopColor: palette.borderSoft },
        crumb.virtual ? { backgroundColor: palette.accentSoft } : undefined,
      ]}
    >
      <View style={[styles.stripe, { backgroundColor: tone }]} />
      <View style={styles.main}>
        <View style={styles.head}>
          <Text
            size={13}
            weight="medium"
            lines={1}
            style={[styles.title, { color: palette[TITLE_INK[kind]] }]}
          >
            {titleOf(crumb, type)}
            {crumb.virtual && (
              <Text size={13} tone="muted">
                {" "}
                - This event
              </Text>
            )}
          </Text>
          <View style={styles.spacer} />
          {level !== null && <Tag label={level} tone={levelTone(level)} />}
          <Text size={12} tone="muted" mono>
            {time}
          </Text>
        </View>
        <Details crumb={crumb} type={type} />
      </View>
    </View>
  );
}
