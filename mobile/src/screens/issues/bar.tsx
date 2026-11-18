// The slim bar the issue list's header collapses into: the page's name, what
// the list is filtered to, and search. Tapping any of it brings the full
// header back, filters and all.

import type { JSX } from "react";
import { Pressable, View } from "react-native";
import Animated, { useAnimatedStyle } from "react-native-reanimated";

import { Icon } from "~/components/icons";
import { Text } from "~/components/text";
import { usePalette } from "~/lib/preferences";
import { CONTROL, SPACE } from "~/lib/theme";

import { barOpacity } from "./collapse";
import type { CollapsingHeader } from "./collapse";

/** The bar's own height, under the status bar. */
export const BAR_HEIGHT = 52;

type CollapsedBarProps = {
  top: number;
  summary: string;
  onOpen: () => void;
  header: CollapsingHeader;
};

function BarContents({ summary, onOpen }: { summary: string; onOpen: () => void }): JSX.Element {
  return (
    <View
      style={{
        height: BAR_HEIGHT,
        flexDirection: "row",
        alignItems: "center",
        paddingLeft: SPACE.lg,
        paddingRight: SPACE.xs,
        gap: SPACE.sm,
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Issues, ${summary}. Show the filters`}
        onPress={onOpen}
        style={{ flex: 1, flexDirection: "row", alignItems: "baseline", gap: SPACE.sm }}
      >
        <Text size={16} weight="medium" tone="heading">
          Issues
        </Text>
        <Text size={13} tone="muted" lines={1} style={{ flexShrink: 1 }}>
          {summary}
        </Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Search issues"
        onPress={onOpen}
        style={{
          width: CONTROL.touch,
          height: CONTROL.touch,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon name="search" size={18} />
      </Pressable>
    </View>
  );
}

export function CollapsedBar({ top, summary, onOpen, header }: CollapsedBarProps): JSX.Element {
  const palette = usePalette();
  const { hidden, range } = header;

  const style = useAnimatedStyle(() => {
    const shown = barOpacity(hidden.get(), range.get());

    return {
      opacity: shown,
      // Taps go through to the full header until the bar is mostly shown.
      pointerEvents: shown > 0.5 ? "auto" : "none",
    };
  });

  return (
    <Animated.View
      style={[
        {
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          paddingTop: top,
          backgroundColor: palette.bg,
        },
        style,
      ]}
    >
      <BarContents summary={summary} onOpen={onOpen} />
    </Animated.View>
  );
}
