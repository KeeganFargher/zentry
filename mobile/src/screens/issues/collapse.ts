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

const SNAP = { duration: 180 };

/** How far through collapsing the header is when the slim bar starts to show. */
const BAR_FROM = 0.55;

/** How far through collapsing the full header's contents are gone. */
const FULL_UNTIL = 0.7;

export type CollapsingHeader = {
  onScroll: ReturnType<typeof useAnimatedScrollHandler>;
  /** How many points of the header are hidden: 0 is open, `range` is collapsed. */
  hidden: SharedValue<number>;
  /** How many points can hide: the header's height above the slim bar's. */
  range: SharedValue<number>;
  /** Takes the collapsing part's height, once it is laid out. */
  measure: (collapsible: number) => void;
  /** Brings the full header back. */
  open: () => void;
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
      range.set(Math.max(collapsible, 0));
    },
    [range],
  );

  const open = useCallback(() => {
    hidden.set(withTiming(0, SNAP));
  }, [hidden]);

  return { onScroll, hidden, range, measure, open };
}

/** Fully open or fully collapsed, whichever is nearer and the scroll allows. */
function snap(hidden: SharedValue<number>, full: number, y: number): void {
  "worklet";

  const now = hidden.get();

  if (now > 0 && now < full) {
    hidden.set(withTiming(now > full / 2 && y >= full ? full : 0, SNAP));
  }
}

/** The title, search and filters fade as they slide up under the bar. */
export function fullOpacity(hidden: number, range: number): number {
  "worklet";

  return interpolate(hidden, [0, range * FULL_UNTIL], [1, 0], Extrapolation.CLAMP);
}

/** The slim bar fades in near the end of collapsing. */
export function barOpacity(hidden: number, range: number): number {
  "worklet";

  return interpolate(hidden, [range * BAR_FROM, range], [0, 1], Extrapolation.CLAMP);
}

/** The height of a laid-out view. */
export function heightOf(event: LayoutChangeEvent): number {
  return event.nativeEvent.layout.height;
}
