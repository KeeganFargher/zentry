// Sentry's toast (getsentry/sentry, static/packages/scraps/src/toast): a card
// with a 1px border and a 2px bottom edge, the message, a small secondary
// action, and a transparent dismiss button. This is its "default" variant,
// the one without a status icon. It rises from the bottom and sinks back when
// dismissed.
//
// Sentry also gives it shadow.medium, a zero-blur 1-2px offset. That is left
// out: the 2px bottom border already draws the same edge, and zero-blur
// shadows render unevenly across Android versions (see button.tsx).

import type { JSX } from "react";
import { Pressable, View } from "react-native";
import Animated, { FadeInDown, FadeOutDown } from "react-native-reanimated";

import { usePalette } from "~/lib/preferences";
import { CONTROL, RADIUS, SPACE } from "~/lib/theme";

import { Button } from "./button";
import { Icon } from "./icons";
import { Text } from "./text";

/** Quick, as Sentry's toasts are: it should arrive, not perform. */
const ENTER = FadeInDown.duration(220);
const EXIT = FadeOutDown.duration(160);

type ToastProps = {
  message: string;
  action: { label: string; onPress: () => void };
  onDismiss: () => void;
  /** Distance from the bottom of the screen, to sit clear of what is there. */
  bottom: number;
};

export function Toast({ message, action, onDismiss, bottom }: ToastProps): JSX.Element {
  const palette = usePalette();

  return (
    <Animated.View
      entering={ENTER}
      exiting={EXIT}
      // Sentry's role="status": TalkBack reads the message when it appears,
      // without interrupting what it was saying.
      accessibilityLiveRegion="polite"
      style={{
        position: "absolute",
        left: SPACE.md,
        right: SPACE.md,
        bottom,
        flexDirection: "row",
        alignItems: "center",
        overflow: "hidden",
        backgroundColor: palette.overlay,
        borderColor: palette.border,
        borderWidth: 1,
        borderBottomWidth: 2,
        borderRadius: RADIUS.md,
      }}
    >
      <View style={{ flex: 1, padding: SPACE.md }}>
        <Text>{message}</Text>
      </View>
      <View style={{ paddingLeft: SPACE.md }}>
        {/* Sentry's is its 28px "xs" button; 36 is as small as a tap target here goes. */}
        <Button
          label={action.label}
          height={CONTROL.compact}
          onPress={() => {
            action.onPress();
            onDismiss();
          }}
        />
      </View>
      {/* Sentry's is a transparent xs button; this keeps a full touch target. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Dismiss"
        onPress={onDismiss}
        style={{
          width: CONTROL.touch,
          height: CONTROL.touch,
          alignItems: "center",
          justifyContent: "center",
          marginHorizontal: SPACE.xs,
        }}
      >
        <Icon name="close" size={14} color={palette.muted} />
      </Pressable>
    </Animated.View>
  );
}
