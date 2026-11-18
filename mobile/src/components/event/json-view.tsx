// Renders free-form JSON (extra data, contexts, local variables, request
// bodies), as ui/src/components/json-view.tsx does: shallow levels open,
// deeper ones folded behind a tap so a big object doesn't flood the screen.

import type { Json, JsonObject } from "@contract";
import { useState } from "react";
import type { JSX } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { Text } from "~/components/text";
import { usePalette } from "~/lib/preferences";
import { SPACE } from "~/lib/theme";

import { describeJson } from "./json";
import { numbered } from "./lists";

/** Nesting deeper than this starts folded. */
const OPEN_DEPTH = 2;

const styles = StyleSheet.create({
  nested: { borderLeftWidth: 1, paddingLeft: SPACE.sm, gap: 2 },
  entry: { flexDirection: "row", flexWrap: "wrap" },
  // A nested object drops below its key instead of squeezing beside it.
  child: { width: "100%" },
  row: { flexDirection: "row", gap: SPACE.sm, paddingVertical: SPACE.xs, borderTopWidth: 1 },
  label: { width: "38%" },
  value: { flex: 1 },
});

type Entry = [key: string, value: Json];

/** Only an object or list with something in it needs a line of its own. */
function opensBelow(value: Json): boolean {
  const node = describeJson(value);

  if (node.kind === "scalar") {
    return false;
  }

  return (node.kind === "list" ? node.items.length : node.entries.length) > 0;
}

function Entries({ entries, depth }: { entries: Entry[]; depth: number }): JSX.Element {
  const palette = usePalette();

  return (
    <View style={[styles.nested, { borderLeftColor: palette.borderSoft }]}>
      {entries.map(([key, item]) => (
        <View key={key} style={styles.entry}>
          <Text size={13} tone="muted" mono>
            {key}:{" "}
          </Text>
          <View style={opensBelow(item) ? styles.child : undefined}>
            <JsonValue value={item} depth={depth + 1} />
          </View>
        </View>
      ))}
    </View>
  );
}

type FoldedProps = { entries: Entry[]; depth: number; noun: string };

function Folded({ entries, depth, noun }: FoldedProps): JSX.Element {
  const [open, setOpen] = useState(false);

  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        hitSlop={SPACE.xs}
      >
        <Text size={13} tone="link">
          {open ? "▾" : "▸"} {entries.length} {noun}
        </Text>
      </Pressable>
      {open && <Entries entries={entries} depth={depth} />}
    </View>
  );
}

function Scalar({ text, quoted }: { text: string; quoted: boolean }): JSX.Element {
  const palette = usePalette();

  // Text reads as text; numbers and booleans stand out, as on Sentry.
  return (
    <Text size={13} selectable style={quoted ? undefined : { color: palette.literal }}>
      {text}
    </Text>
  );
}

export function JsonValue({ value, depth }: { value: Json; depth: number }): JSX.Element {
  const node = describeJson(value);

  if (value === null) {
    return (
      <Text size={13} tone="muted">
        --
      </Text>
    );
  }

  if (node.kind === "scalar") {
    return <Scalar text={node.text} quoted={node.quoted} />;
  }

  const entries =
    node.kind === "list"
      ? node.items.map((item, index): Entry => [String(index), item])
      : node.entries;

  if (entries.length === 0) {
    return (
      <Text size={13} tone="muted">
        {node.kind === "list" ? "[]" : "{}"}
      </Text>
    );
  }

  if (depth < OPEN_DEPTH) {
    return <Entries entries={entries} depth={depth} />;
  }

  return <Folded entries={entries} depth={depth} noun={node.kind === "list" ? "items" : "keys"} />;
}

export type Row = [label: string, value: Json];

/**
 * Label on the left, value on the right. Labels can repeat (headers, query
 * keys), so rows are keyed by position.
 */
export function Rows({ rows }: { rows: Row[] }): JSX.Element {
  const palette = usePalette();

  return (
    <View>
      {numbered(rows).map(([index, [label, value]]) => (
        <View key={index} style={[styles.row, { borderTopColor: palette.borderSoft }]}>
          <Text size={13} tone="muted" selectable style={styles.label}>
            {label}
          </Text>
          <View style={styles.value}>
            <JsonValue value={value} depth={0} />
          </View>
        </View>
      ))}
    </View>
  );
}

/** An object's top-level keys as label/value rows. */
export function KeyValueTable({ data }: { data: JsonObject }): JSX.Element {
  return <Rows rows={Object.entries(data)} />;
}
