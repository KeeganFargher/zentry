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
  /** Brings the full header back. */
  open: () => void;
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
      range.set(Math.max(collapsible, 0));
    },
    [range],
  );

  const open = useCallback(() => {
    hidden.set(withTiming(0, SNAP));
  }, [hidden]);

  const openThen = useCallback(
    (then: () => void) => {
      hidden.set(
        withTiming(0, SNAP, (finished) => {
          if (finished === true) {
            scheduleOnRN(then);
          }
        }),
      );
    },
    [hidden],
  );

  return { onScroll, hidden, range, measure, open, openThen };
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
