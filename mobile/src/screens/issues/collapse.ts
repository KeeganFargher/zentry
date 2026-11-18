// The issue list's header collapses as the list scrolls down and comes back
// as soon as it scrolls up ("quick return"), so the filters take the screen
// only while you want them. All of it runs on the UI thread from the scroll
// events, so the header keeps pace with the finger.

import { useCallback } from "react";
import type { LayoutChangeEvent } from "react-native";
import {
  Extrapolation,
  interpolate,
  useAnimatedScrollHandler,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import type { SharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";

const SNAP = { duration: 180 };

export type CollapsingHeader = {
  onScroll: ReturnType<typeof useAnimatedScrollHandler>;
  /** How many points of the header are hidden: 0 is open, `range` is collapsed. */
  hidden: SharedValue<number>;
  /** How many points can hide: the header's height above the slim bar's. */
  range: SharedValue<number>;
  /** Takes the collapsing part's height, once it is laid out. */
  measure: (collapsible: number) => void;
  /** Brings the full header back, then runs `then`: focusing search, say. */
  openThen: (then: () => void) => void;
};

export function useCollapsingHeader(): CollapsingHeader {
  const hidden = useSharedValue(0);
  const range = useSharedValue(0);
  const lastY = useSharedValue(0);

  const onScroll = useAnimatedScrollHandler({
    onScroll: (event) => {
      const y = event.contentOffset.y;
      const delta = y - lastY.get();

      lastY.set(y);

      // Down hides, up shows, by as much as the list moved. Never hidden by
      // more than the list has scrolled: at the top the header is always open,
      // or it would cover the first rows.
      const next = Math.min(Math.max(hidden.get() + delta, 0), range.get());

      hidden.set(Math.min(next, Math.max(y, 0)));
    },
    // Let go halfway and it settles open or closed, never stuck in between:
    // when the finger lifts, and again when a fling stops, since the fling's
    // own scroll events move the header after the first snap.
    onEndDrag: (event) => {
      snap(hidden, range.get(), event.contentOffset.y);
    },
    onMomentumEnd: (event) => {
      snap(hidden, range.get(), event.contentOffset.y);
    },
  });

  const measure = useCallback(
    (collapsible: number) => {
      const next = Math.max(collapsible, 0);

      // The header's height changes while collapsed (the projects error comes
      // or goes): keep it fully collapsed rather than hidden past its new
      // height (the table header would slide under the bar) or left part-open
      // (no scroll ends to snap it).
      if (hidden.get() > 0 && hidden.get() >= range.get()) {
        hidden.set(next);
      } else {
        hidden.set(Math.min(hidden.get(), next));
      }

      range.set(next);
    },
    [hidden, range],
  );

  const openThen = useCallback(
    (then: () => void) => {
      hidden.set(
        withTiming(0, SNAP, (finished) => {
          // A scroll during the opening interrupts it: the user has moved on,
          // so whatever was to follow (focusing search) is dropped on purpose.
          if (finished === true) {
            scheduleOnRN(then);
          }
        }),
      );
    },
    [hidden],
  );

  return { onScroll, hidden, range, measure, openThen };
}

/** Fully open or fully collapsed, whichever is nearer and the scroll allows. */
function snap(hidden: SharedValue<number>, full: number, y: number): void {
  "worklet";

  const now = hidden.get();

  if (now > 0 && now < full) {
    hidden.set(withTiming(now > full / 2 && y >= full ? full : 0, SNAP));
  }
}

/** How far the header has collapsed, from 0 (open) to 1 (collapsed). */
export function progressOf(hidden: number, range: number): number {
  "worklet";

  return range <= 0 ? 0 : Math.min(Math.max(hidden / range, 0), 1);
}

/**
 * How far one element is through its own part of the collapse, from 0 to 1:
 * each element moves within a window of the whole, so they move one after
 * another rather than together.
 */
export function phase(progress: number, from: number, to: number): number {
  "worklet";

  return interpolate(progress, [from, to], [0, 1], Extrapolation.CLAMP);
}

/** The height of a laid-out view. */
export function heightOf(event: LayoutChangeEvent): number {
  return event.nativeEvent.layout.height;
}

/**
 * When each part moves, as windows of the collapse's progress (0 open, 1
 * collapsed). The full header's parts leave in the first half, top to
 * bottom, so the eye follows one movement down the header; the bar's parts
 * arrive in the second half, once the space they need has cleared. Nothing
 * is tappable while it is mostly faded: `HANDOFF` is where taps move from
 * the header to the bar, and every leaving part is gone by then.
 */
export const TIMELINE = {
  /** The organization name, first and quickest: it has nowhere to go. */
  caption: [0, 0.3],
  /**
   * The search field. It rides up under the title (which is drawn above it)
   * while it fades, so it is gone well before the bar's search button shows.
   */
  search: [0.04, 0.42],
  /** The dropdowns, each starting this much after the one to its left. */
  dropdowns: { start: 0.12, step: 0.08, length: 0.3 },
  /** The projects error leaves with the dropdowns it explains. */
  projectsError: [0.12, 0.42],
  /** Taps go to the bar from here on, as its search button appears. */
  handoff: 0.5,
  /** The bar's search button, where the search field was headed. */
  searchButton: [0.5, 0.95],
  /** The summary, last, beside the title once it has nearly arrived. */
  summary: [0.62, 1],
} as const;
