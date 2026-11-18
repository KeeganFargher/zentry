// Tells you when an over-the-air update has downloaded, with a button to
// restart into it. Without it the update waits for the next cold start, which
// on Android can be days away: the app mostly resumes from the background.

import * as Updates from "expo-updates";
import { useEffect, useRef, useState } from "react";
import type { JSX, RefObject } from "react";
import { Alert, AppState } from "react-native";

import { Toast } from "./toast";

/**
 * The failures expo-updates itself records, as useUpdates' checkError and
 * downloadError (Settings shows them): offline, or the update server down.
 * Anything else is a bug and must not be swallowed with them.
 */
const RECORDED = new Set(["ERR_UPDATES_CHECK", "ERR_UPDATES_FETCH"]);

function isRecorded(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && RECORDED.has(String(cause.code));
}

/**
 * expo-updates checks on a cold start only. Checking again whenever the app
 * comes back to the foreground means an update reaches you in the session
 * you are in. Not in development builds, where Metro serves the code, and not
 * once one is waiting: the newest is fetched on the restart anyway.
 */
function useCheckOnForeground(pending: RefObject<boolean>): void {
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active" || !Updates.isEnabled || pending.current) {
        return;
      }

      fetchIfAvailable().catch((cause: unknown) => {
        // Recorded failures retry on the next foreground. Rethrown, the rest
        // surface as unhandled rejections: loud in development, and in logcat.
        if (!isRecorded(cause)) {
          throw cause;
        }
      });
    });

    return () => subscription.remove();
  }, [pending]);
}

/**
 * Fetches a newer update, if there is one. A rollback to the APK's own bundle
 * (isRollBackToEmbedded) is left for the next cold start, which applies it:
 * it only ever undoes a bad update, and needs no prompt.
 */
async function fetchIfAvailable(): Promise<void> {
  const check = await Updates.checkForUpdateAsync();

  if (check.isAvailable) {
    await Updates.fetchUpdateAsync();
  }
}

function restart(): void {
  Updates.reloadAsync().catch((cause: unknown) => {
    // reloadAsync rejects with an Error (a CodedError); anything else is a bug.
    if (!(cause instanceof Error)) {
      throw cause;
    }

    Alert.alert(
      "Could not restart",
      `${cause.message}\n\nClose and reopen the app to use the new version.`,
    );
  });
}

/** Clear of the screen's bottom edge: the tab bar's top, plus a gap. */
export function UpdateToast({ bottom }: { bottom: number }): JSX.Element | null {
  // useUpdates follows downloads from the launch check and from ours.
  const { isUpdatePending } = Updates.useUpdates();
  // Dismissed for the session: with an update waiting nothing newer is
  // fetched (see useCheckOnForeground), so there is nothing newer to announce.
  const [dismissed, setDismissed] = useState(false);
  const pending = useRef(isUpdatePending);

  useEffect(() => {
    pending.current = isUpdatePending;
  }, [isUpdatePending]);

  useCheckOnForeground(pending);

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
