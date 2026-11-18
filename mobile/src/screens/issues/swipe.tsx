// A list row that swipes sideways to act on its issue, with the axis locked:
// a drag only becomes a swipe once it has moved clearly sideways, and gives
// way to the list's scroll as soon as it moves up or down first.
//
// Not ReanimatedSwipeable: it lets a swipe start after 10px sideways
// whatever the vertical movement, with no way to fail on vertical movement,
// so a slightly diagonal scroll was taken as a swipe and archived issues.

import { useMemo } from "react";
import type { JSX, ReactNode } from "react";
import { View } from "react-native";
import { GestureDetector, usePanGesture } from "react-native-gesture-handler";
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";

/** Sideways movement, either way, before a drag becomes a swipe. */
const ACTIVATE_X: [number, number] = [-24, 24];

/** Vertical movement that hands the drag to the list's scroll, if it comes first. */
const FAIL_Y: [number, number] = [-12, 12];

/** How far the row must travel for a release to act, as before (90 points). */
const THRESHOLD = 90;

/** The row moves slower than the finger, so a swipe reads as deliberate. */
const FRICTION = 1.5;

export type SwipeSide = "right" | "left";

type SwipeRowProps = {
  enabled: boolean;
  /** Shown behind the row as it moves right. */
  rightPanel: ReactNode;
  /** Shown behind the row as it moves left. */
  leftPanel: ReactNode;
  /** A completed swipe past the threshold, by the side the row moved to. */
  onSwipe: (side: SwipeSide) => void;
  children: ReactNode;
};

export function SwipeRow({
  enabled,
  rightPanel,
  leftPanel,
  onSwipe,
  children,
}: SwipeRowProps): JSX.Element {
  const offset = useSharedValue(0);

  const pan = usePanGesture(
    useMemo(
      () => ({
        enabled,
        activeOffsetX: ACTIVATE_X,
        failOffsetY: FAIL_Y,
        onUpdate: (event: { translationX: number }) => {
          "worklet";
          offset.set(event.translationX / FRICTION);
        },
        onDeactivate: (event: { translationX: number; canceled: boolean }) => {
          "worklet";
          const travelled = event.translationX / FRICTION;

          // A cancelled drag (the scroll or another gesture took over) only
          // springs back; it never acts.
          if (!event.canceled && Math.abs(travelled) >= THRESHOLD) {
            scheduleOnRN(onSwipe, travelled > 0 ? "right" : "left");
          }

          offset.set(withSpring(0, { duration: 250 }));
        },
      }),
      [enabled, offset, onSwipe],
    ),
  );

  const rowStyle = useAnimatedStyle(() => ({ transform: [{ translateX: offset.get() }] }));
  const rightStyle = useAnimatedStyle(() => ({ opacity: offset.get() > 0 ? 1 : 0 }));
  const leftStyle = useAnimatedStyle(() => ({ opacity: offset.get() < 0 ? 1 : 0 }));

  return (
    <View>
      <Animated.View pointerEvents="none" style={[{ position: "absolute", inset: 0 }, rightStyle]}>
        {rightPanel}
      </Animated.View>
      <Animated.View pointerEvents="none" style={[{ position: "absolute", inset: 0 }, leftStyle]}>
        {leftPanel}
      </Animated.View>
      <GestureDetector gesture={pan}>
        <Animated.View style={rowStyle}>{children}</Animated.View>
      </GestureDetector>
    </View>
  );
}
