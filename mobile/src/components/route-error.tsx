// What a screen shows when it throws while rendering: Expo Router catches it
// at the route (each route file exports this as ErrorBoundary), so a bug or a
// response this app does not understand fails loudly on that screen alone,
// with the error's own message, instead of taking the whole app down.

import type { ErrorBoundaryProps } from "expo-router";
import type { JSX } from "react";
import { View } from "react-native";

import { usePalette } from "~/lib/preferences";

import { Notice } from "./basics";

export function RouteError({ error, retry }: ErrorBoundaryProps): JSX.Element {
  const palette = usePalette();

  return (
    <View style={{ flex: 1, backgroundColor: palette.surface }}>
      <Notice loading={false} error={error} onRetry={() => void retry()} />
    </View>
  );
}
