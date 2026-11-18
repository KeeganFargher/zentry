// Tells you when an over-the-air update has downloaded, with a button to
// restart into it. Without it the update waits for the next cold start, which
// on Android can be days away: the app mostly resumes from the background.

import * as Updates from "expo-updates";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { Alert, AppState } from "react-native";

import { Toast } from "./toast";

/**
 * expo-updates checks on a cold start only. Checking again whenever the app
 * comes back to the foreground means an update reaches you in the session
 * you are in. Not in development builds, where Metro serves the code.
 */
function useCheckOnForeground(): void {
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active" && Updates.isEnabled) {
        // Offline, or the update server down: expo-updates records the
        // failure as useUpdates' checkError or downloadError, which Settings
        // shows, and the next foreground tries again. Caught here only so it
        // is not also an unhandled rejection.
        fetchIfAvailable().catch(() => undefined);
      }
    });

    return () => subscription.remove();
  }, []);
}

async function fetchIfAvailable(): Promise<void> {
  const check = await Updates.checkForUpdateAsync();

  if (check.isAvailable) {
    await Updates.fetchUpdateAsync();
  }
}

function restart(): void {
  Updates.reloadAsync().catch((cause: unknown) => {
    Alert.alert(
      "Could not restart",
      `${cause instanceof Error ? cause.message : "The restart failed"}. Close and reopen the app to use the new version.`,
    );
  });
}

/** Clear of the screen's bottom edge: the tab bar's top, plus a gap. */
export function UpdateToast({ bottom }: { bottom: number }): JSX.Element | null {
  // useUpdates follows downloads from the launch check and from ours.
  const { isUpdatePending } = Updates.useUpdates();
  const [dismissed, setDismissed] = useState(false);

  useCheckOnForeground();

  if (!isUpdatePending || dismissed) {
    return null;
  }

  return (
    <Toast
      message="A new version of Zentry is ready."
      action={{ label: "Restart", onPress: restart }}
      onDismiss={() => setDismissed(true)}
      bottom={bottom}
    />
  );
}
