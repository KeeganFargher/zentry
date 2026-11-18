// The slim bar the issue list's header collapses into. Its title is the
// header's own "Issues", which glides into place (header.tsx); the bar adds
// what the list is filtered to, sliding in beside it, and a search button.
// Tapping the bar brings the full header back; search also focuses the field.

import type { JSX } from "react";
import { Pressable, View } from "react-native";
import Animated, { useAnimatedStyle } from "react-native-reanimated";

import { Icon } from "~/components/icons";
import { Text } from "~/components/text";
import { CONTROL, SPACE } from "~/lib/theme";

import { TIMELINE, phase, progressOf } from "./collapse";
import type { CollapsingHeader } from "./collapse";
import type { TitleMetrics } from "./header";

/** The bar's own height, under the status bar. */
export const BAR_HEIGHT = 52;

/** The title's size in the bar, against its 24 points in the full header. */
export const TITLE_SCALE = 16 / 24;

type CollapsedBarProps = {
  top: number;
  summary: string;
  header: CollapsingHeader;
  metrics: TitleMetrics;
  onOpen: () => void;
  onSearch: () => void;
};

type PartProps = { header: CollapsingHeader; metrics: TitleMetrics };

/**
 * What the list is filtered to, beside the shrunken title, sliding in from
 * the right as it arrives. The title's room is a margin, not a transform, so
 * a long summary truncates before the search button rather than under it.
 */
function Summary({ header, metrics, summary }: PartProps & { summary: string }): JSX.Element {
  const { hidden, range } = header;

  const style = useAnimatedStyle(() => {
    const [from, to] = TIMELINE.summary;
    const shown = phase(progressOf(hidden.get(), range.get()), from, to);

    return {
      opacity: shown,
      marginLeft: metrics.width.get() * TITLE_SCALE + SPACE.sm,
      transform: [{ translateX: 14 * (1 - shown) }],
    };
  });

  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        left: SPACE.lg,
        right: CONTROL.touch + SPACE.sm,
        top: 0,
        bottom: 0,
        justifyContent: "center",
      }}
    >
      <Animated.View style={style}>
        <Text size={13} tone="muted" lines={1}>
          {summary}
        </Text>
      </Animated.View>
    </View>
  );
}

/** Scales up where the full header's search field shrank toward. */
function SearchButton({
  header,
  onSearch,
}: {
  header: CollapsingHeader;
  onSearch: () => void;
}): JSX.Element {
  const { hidden, range } = header;

  const style = useAnimatedStyle(() => {
    const [from, to] = TIMELINE.searchButton;
    const shown = phase(progressOf(hidden.get(), range.get()), from, to);

    // Grows from smaller than itself, as the search field shrank: one control
    // changing size rather than one leaving and another arriving.
    return { opacity: shown, transform: [{ scale: 0.6 + 0.4 * shown }] };
  });

  return (
    <Animated.View
      style={[
        { position: "absolute", right: SPACE.xs, top: (BAR_HEIGHT - CONTROL.touch) / 2 },
        style,
      ]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Search issues"
        onPress={onSearch}
        style={{
          width: CONTROL.touch,
          height: CONTROL.touch,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Icon name="search" size={18} />
      </Pressable>
    </Animated.View>
  );
}

export function CollapsedBar(props: CollapsedBarProps): JSX.Element {
  const { top, summary, header, metrics, onOpen, onSearch } = props;
  const { hidden, range } = header;

  const bar = useAnimatedStyle(() => ({
    // Taps go through to the full header until the bar's parts start to show.
    pointerEvents: progressOf(hidden.get(), range.get()) >= TIMELINE.handoff ? "auto" : "none",
  }));

  return (
    <Animated.View
      style={[{ position: "absolute", top, left: 0, right: 0, height: BAR_HEIGHT }, bar]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Issues, ${summary}. Show the filters`}
        onPress={onOpen}
        style={{ position: "absolute", inset: 0 }}
      />
      <Summary header={header} metrics={metrics} summary={summary} />
      <SearchButton header={header} onSearch={onSearch} />
    </Animated.View>
  );
}
