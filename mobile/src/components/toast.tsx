// Sentry's toast (getsentry/sentry, static/packages/scraps/src/toast): a card
// on the primary background with a 1px border and a 2px bottom edge, the
// message, a small secondary action, and a transparent dismiss button. This
// is its "default" variant, the one without a status icon. It rises from the
// bottom and sinks back when dismissed.

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
      accessibilityRole="alert"
      style={{
        position: "absolute",
        left: SPACE.md,
        right: SPACE.md,
        bottom,
        flexDirection: "row",
        alignItems: "center",
        backgroundColor: palette.bg,
        borderColor: palette.border,
        borderWidth: 1,
        borderBottomWidth: 2,
        borderRadius: RADIUS.md,
        // Sentry's shadow.medium: the toast floats over the page.
        boxShadow: "0px 2px 8px rgba(0, 0, 0, 0.12)",
      }}
    >
      <View style={{ flex: 1, padding: SPACE.lg }}>
        <Text>{message}</Text>
      </View>
      <Button
        label={action.label}
        height={CONTROL.compact}
        onPress={() => {
          action.onPress();
          onDismiss();
        }}
      />
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
