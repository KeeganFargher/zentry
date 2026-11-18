// The pieces every event section is built from: the section block with its
// title and controls, a text button and a horizontally scrolling code block.

import { useState } from "react";
import type { JSX, ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";

import { Heading, Text } from "~/components/text";
import { usePalette } from "~/lib/preferences";
import { MONO, RADIUS, SPACE } from "~/lib/theme";

const styles = StyleSheet.create({
  // A flat block between dividers, as Sentry's issue page lays out sections.
  block: { borderBottomWidth: 1, padding: SPACE.lg, gap: SPACE.md },
  body: { gap: SPACE.md },
  hidden: { display: "none" },
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: 44,
  },
  controls: { flexDirection: "row", flexWrap: "wrap", gap: SPACE.sm },
  link: {
    alignSelf: "flex-start",
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: SPACE.sm,
  },
  code: { borderRadius: RADIUS.md, borderWidth: 1, paddingVertical: SPACE.sm },
  codeText: { paddingHorizontal: SPACE.md, fontFamily: MONO.regular, fontSize: 12, lineHeight: 20 },
});

type SectionProps = {
  title: string;
  children: ReactNode;
  /** Switches and buttons, shown under the title so they wrap on a phone. */
  actions?: ReactNode;
  /** Starts closed behind its title, as the web's folded sections do. */
  folded?: boolean;
};

export function EventSection({
  title,
  children,
  actions,
  folded = false,
}: SectionProps): JSX.Element {
  const palette = usePalette();
  const [open, setOpen] = useState(!folded);

  return (
    <View
      style={[styles.block, { backgroundColor: palette.bg, borderBottomColor: palette.borderSoft }]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        style={styles.head}
      >
        <Heading>{title}</Heading>
        <Text tone="link" size={13}>
          {open ? "Hide" : "Show"}
        </Text>
      </Pressable>
      {/* Hidden, not unmounted, so a folded section keeps its frames and filters. */}
      <View style={open ? styles.body : styles.hidden}>
        {actions !== undefined && <View style={styles.controls}>{actions}</View>}
        {children}
      </View>
    </View>
  );
}

/** A text-only button, for "Show all" and "Show 3 more frames". */
export function LinkButton({
  label,
  onPress,
}: {
  label: string;
  onPress: () => void;
}): JSX.Element {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={styles.link} hitSlop={SPACE.sm}>
      <Text size={13} weight="medium" tone="link">
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * Preformatted text (raw traces, curl, raw extra data). It scrolls sideways
 * rather than wrapping, since wrapped code lines are harder to read than
 * a swipe.
 */
export function CodeBlock({ text }: { text: string }): JSX.Element {
  const palette = usePalette();

  return (
    <ScrollView
      horizontal
      style={[styles.code, { backgroundColor: palette.surface, borderColor: palette.border }]}
    >
      <Text selectable mono style={[styles.codeText, { color: palette.text }]}>
        {text}
      </Text>
    </ScrollView>
  );
}
