// The app's building blocks, in Sentry's component styles (scraps): panels,
// tinted tags, the level bar, and the states every screen passes through.

import type { Level } from "@contract";
import type { JSX, ReactNode } from "react";
import { ActivityIndicator, View } from "react-native";
import type { StyleProp, ViewStyle } from "react-native";

import { levelLabel } from "~/lib/issue";
import { usePalette } from "~/lib/preferences";
import { levelColor, RADIUS, SPACE } from "~/lib/theme";
import type { Palette } from "~/lib/theme";

import { Button } from "./button";
import { Text } from "./text";

export function Panel({
  children,
  style,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}): JSX.Element {
  const palette = usePalette();

  return (
    <View
      style={[
        {
          backgroundColor: palette.bg,
          borderColor: palette.border,
          borderWidth: 1,
          borderRadius: RADIUS.md,
          padding: SPACE.lg,
          gap: SPACE.sm,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

export type TagTone = "neutral" | "accent" | "danger" | "warning" | "success";

const TAG_COLORS: Record<TagTone, (palette: Palette) => [fill: string, text: string]> = {
  accent: (palette) => [palette.accentSoft, palette.link],
  danger: (palette) => [palette.dangerSoft, palette.danger],
  warning: (palette) => [palette.warningSoft, palette.warningText],
  success: (palette) => [palette.okSoft, palette.ok],
  neutral: (palette) => [palette.raised, palette.muted],
};

/** Sentry's tag: a small tinted label, 20px high. */
export function Tag({ label, tone }: { label: string; tone: TagTone }): JSX.Element {
  const palette = usePalette();
  const [fill, text] = TAG_COLORS[tone](palette);

  return (
    <View
      style={{
        height: 20,
        paddingHorizontal: 6,
        borderRadius: RADIUS.sm,
        backgroundColor: fill,
        justifyContent: "center",
        alignSelf: "flex-start",
      }}
    >
      <Text size={12} lines={1} style={{ color: text }}>
        {label}
      </Text>
    </View>
  );
}

/**
 * The tag for an issue's state (lib/issue.ts substatus). Ongoing gets one too
 * on the issue page; the list leaves it off, since most issues are ongoing.
 */
const STATE_TONES = new Map<string, TagTone>([
  ["New", "accent"],
  ["Ongoing", "neutral"],
  ["Regressed", "danger"],
  ["Resolved", "success"],
  ["Archived", "neutral"],
]);

export function stateTone(state: string): TagTone {
  const tone = STATE_TONES.get(state);

  if (tone === undefined) {
    throw new Error(`No tag for the issue state ${state}`);
  }

  return tone;
}

/** The tag tone Sentry gives a level, for breadcrumbs and the like. */
export function levelTone(level: string): TagTone {
  switch (level) {
    case "fatal":
    case "error": {
      return "danger";
    }

    case "warning": {
      return "warning";
    }

    case "info": {
      return "accent";
    }

    default: {
      return "neutral";
    }
  }
}

/** The short coloured bar Sentry puts before an issue's message. */
export function LevelBar({ level }: { level: Level }): JSX.Element {
  const palette = usePalette();

  return (
    <View
      accessible
      accessibilityLabel={levelLabel(level)}
      style={{ width: 3, height: 14, borderRadius: 2, backgroundColor: levelColor(palette, level) }}
    />
  );
}

/** Loading, failed, or nothing to show: the three states before content. */
export function Notice({
  loading,
  error,
  empty,
  onRetry,
}: {
  loading: boolean;
  error: Error | null;
  empty?: string;
  onRetry?: () => void;
}): JSX.Element {
  const palette = usePalette();

  return (
    <View style={{ padding: SPACE.xl, alignItems: "center", gap: SPACE.md }}>
      {loading ? (
        <ActivityIndicator color={palette.accent} />
      ) : error !== null ? (
        <>
          <Text tone="danger" style={{ textAlign: "center" }}>
            {error.message}
          </Text>
          {onRetry !== undefined && <Button label="Try again" onPress={onRetry} />}
        </>
      ) : (
        <Text tone="muted" style={{ textAlign: "center" }}>
          {empty ?? "Nothing here."}
        </Text>
      )}
    </View>
  );
}

/** A label and value on one line, for facts such as "First seen". */
export function Fact({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <View style={{ flexDirection: "row", justifyContent: "space-between", gap: SPACE.md }}>
      <Text tone="muted" size={13}>
        {label}
      </Text>
      <Text size={13} selectable style={{ flexShrink: 1, textAlign: "right" }}>
        {value}
      </Text>
    </View>
  );
}
