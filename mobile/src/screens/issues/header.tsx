// The issue list's header, floating over the list, with each part moving on
// its own as it collapses (collapse.ts): the organization name fades first,
// the search field shrinks toward the bar's search button, the dropdowns lift
// away one after another, and the "Issues" title glides up and shrinks into
// the slim bar's title, so the two read as one element changing shape.

import type { ApiProject } from "@contract";
import type { UseQueryResult } from "@tanstack/react-query";
import { createContext, use, useMemo } from "react";
import type { ComponentRef, JSX, ReactNode, Ref } from "react";
import type { TextInput } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import type { SharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Text } from "~/components/text";
import { useOrganization } from "~/lib/organization";
import { usePalette } from "~/lib/preferences";
import { SPACE } from "~/lib/theme";

import { BAR_HEIGHT, TITLE_SCALE } from "./bar";
import { TIMELINE, heightOf, phase, progressOf } from "./collapse";
import type { CollapsingHeader } from "./collapse";
import { FilterButtons, ListHeader, SearchField } from "./filters";
import type { Filters } from "./filters";

/**
 * Where the big title sits in the header, measured, so it can be moved onto
 * the bar's: its group's offset (padding included) plus its place in the
 * group, under the organization name.
 */
export type TitleMetrics = {
  groupY: SharedValue<number>;
  y: SharedValue<number>;
  height: SharedValue<number>;
  width: SharedValue<number>;
};

export function useTitleMetrics(): TitleMetrics {
  const groupY = useSharedValue(0);
  const y = useSharedValue(0);
  const height = useSharedValue(0);
  const width = useSharedValue(0);

  // One object for the screen's life: the animated styles capture it, and a
  // new one each render would rebuild every one of them.
  return useMemo(() => ({ groupY, y, height, width }), [groupY, y, height, width]);
}

export type SearchInput = ComponentRef<typeof TextInput>;

/** The collapse, for the parts below that each move in their own way. */
const Collapse = createContext<CollapsingHeader | null>(null);

function useCollapse(): CollapsingHeader {
  const header = use(Collapse);

  if (header === null) {
    throw new Error("A header part outside FloatingHeader");
  }

  return header;
}

/**
 * Whether a part that is this far gone still takes taps: opacity alone does
 * not stop them, and a tap on something you can barely see (or that is under
 * the bar's search button) would open what you did not mean to.
 */
function touchable(gone: number): "auto" | "none" {
  "worklet";

  return gone < 0.5 ? "auto" : "none";
}

/**
 * A style that fades a part away within its window of the collapse, lifting
 * it a few points as it goes so it reads as leaving, not just dimming.
 */
function useLeave(window: readonly [number, number], lift: number) {
  const { hidden, range } = useCollapse();
  const [from, to] = window;

  return useAnimatedStyle(() => {
    const gone = phase(progressOf(hidden.get(), range.get()), from, to);

    return {
      opacity: 1 - gone,
      pointerEvents: touchable(gone),
      transform: [{ translateY: -lift * gone }],
    };
  });
}

/** One dropdown, lifting away in its turn: left first, right last. */
function StaggerItem({ index, children }: { index: number; children: ReactNode }): JSX.Element {
  const { start, step, length } = TIMELINE.dropdowns;
  const from = start + index * step;
  const style = useLeave([from, from + length], 10);

  return <Animated.View style={[{ flexGrow: 1, flexBasis: 0 }, style]}>{children}</Animated.View>;
}

/**
 * "Issues", which becomes the bar's title: it moves from where it sits to
 * the bar's title position (and the header slides away beneath it), and
 * shrinks to the bar's size, scaled from its top-left corner so its left
 * edge stays in line with the bar's.
 */
function MorphingTitle({ metrics, top }: { metrics: TitleMetrics; top: number }): JSX.Element {
  const { hidden, range } = useCollapse();

  const style = useAnimatedStyle(() => {
    const progress = progressOf(hidden.get(), range.get());
    const scale = 1 - progress * (1 - TITLE_SCALE);
    // On screen the title is at its y - hidden + lift; collapsed, it must sit
    // centred in the bar.
    const target = top + (BAR_HEIGHT - metrics.height.get() * TITLE_SCALE) / 2;
    const lift = progress * (target - metrics.groupY.get() - metrics.y.get() + range.get());

    return { transform: [{ translateY: lift }, { scale }] };
  });

  return (
    <Animated.View
      accessibilityRole="header"
      onLayout={(event) => {
        metrics.y.set(event.nativeEvent.layout.y);
        metrics.height.set(heightOf(event));
        metrics.width.set(event.nativeEvent.layout.width);
      }}
      style={[{ alignSelf: "flex-start", transformOrigin: "left top" }, style]}
    >
      <Text size={24} weight="medium" tone="heading">
        Issues
      </Text>
    </Animated.View>
  );
}

/** The organization's name over the title; it leaves first. */
function TitleGroup({ metrics, top }: { metrics: TitleMetrics; top: number }): JSX.Element {
  const organization = useOrganization();
  const caption = useLeave(TIMELINE.caption, 6);

  return (
    <Animated.View
      onLayout={(event) => metrics.groupY.set(event.nativeEvent.layout.y)}
      // Above the search field, which rides up under the title as both move.
      style={{ zIndex: 1 }}
    >
      <Animated.View style={caption}>
        <Text size={12} tone="muted" lines={1}>
          {organization.name}
        </Text>
      </Animated.View>
      <MorphingTitle metrics={metrics} top={top} />
    </Animated.View>
  );
}

/** Fades as it shrinks toward the right, where the bar's search button appears. */
function ShrinkingSearch(props: {
  filters: Filters;
  onFilters: (filters: Filters) => void;
  searchRef: Ref<SearchInput>;
}): JSX.Element {
  const { hidden, range } = useCollapse();

  const style = useAnimatedStyle(() => {
    const [from, to] = TIMELINE.search;
    const gone = phase(progressOf(hidden.get(), range.get()), from, to);

    // A slight shrink about its right edge, where the bar's search button
    // will appear, so the field reads as folding into that button.
    return {
      opacity: 1 - gone,
      pointerEvents: touchable(gone),
      transform: [{ scale: 1 - 0.12 * gone }],
    };
  });

  return (
    <Animated.View style={[{ transformOrigin: "right center" }, style]}>
      <SearchField
        query={props.filters.query}
        onSearch={(query) => props.onFilters({ ...props.filters, query })}
        inputRef={props.searchRef}
      />
    </Animated.View>
  );
}

function ProjectsError({ error }: { error: Error }): JSX.Element {
  const style = useLeave(TIMELINE.projectsError, 0);

  // Without the projects, the project dropdown can only offer "All Projects".
  return (
    <Animated.View style={style}>
      <Text tone="danger" size={13}>
        Could not load projects: {error.message}
      </Text>
    </Animated.View>
  );
}

type FloatingHeaderProps = {
  header: CollapsingHeader;
  metrics: TitleMetrics;
  filters: Filters;
  onFilters: (filters: Filters) => void;
  projects: UseQueryResult<ApiProject[]>;
  searchRef: Ref<SearchInput>;
  /** The whole header's height, which the list's first row starts below. */
  onHeight: (height: number) => void;
};

/** Title, search, filters and the table header, floating over the list. */
export function FloatingHeader(props: FloatingHeaderProps): JSX.Element {
  const { header, metrics, filters, onFilters, projects, searchRef, onHeight } = props;
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  // Only the shared value goes into the worklet: capturing `header` would copy
  // its scroll handler too, which worklets cannot copy.
  const { hidden } = header;
  const slide = useAnimatedStyle(() => ({ transform: [{ translateY: -hidden.get() }] }));

  return (
    <Collapse value={header}>
      <Animated.View
        onLayout={(event) => onHeight(heightOf(event))}
        // The background stays opaque while the parts fade, so rows never
        // show through; collapsed, its last points are the bar's backdrop.
        style={[
          { position: "absolute", top: 0, left: 0, right: 0, backgroundColor: palette.bg },
          slide,
        ]}
      >
        <Animated.View
          // What collapses: all of this but the slim bar's height, so the
          // table header ends up just under the bar.
          onLayout={(event) => header.measure(heightOf(event) - insets.top - BAR_HEIGHT)}
          style={{
            paddingTop: insets.top + SPACE.lg,
            paddingHorizontal: SPACE.lg,
            paddingBottom: SPACE.md,
            gap: SPACE.md,
          }}
        >
          <TitleGroup metrics={metrics} top={insets.top} />
          <ShrinkingSearch filters={filters} onFilters={onFilters} searchRef={searchRef} />
          <FilterButtons
            filters={filters}
            projects={projects.data ?? []}
            onChange={onFilters}
            Item={StaggerItem}
          />
          {projects.error !== null && <ProjectsError error={projects.error} />}
        </Animated.View>
        <ListHeader sort={filters.sort} onSort={(sort) => onFilters({ ...filters, sort })} />
      </Animated.View>
    </Collapse>
  );
}
