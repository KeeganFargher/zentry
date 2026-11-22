// The app shell: fonts, theme, data cache, and the sign-in gate. A signed-out
// phone sees only the pairing screen; a signed-in one, everything else.

import { RobotoMono_400Regular, RobotoMono_500Medium } from "@expo-google-fonts/roboto-mono";
import { Rubik_400Regular, Rubik_500Medium, useFonts } from "@expo-google-fonts/rubik";
import { focusManager, useIsRestoring } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import * as SystemUI from "expo-system-ui";
import { useEffect } from "react";
import type { JSX, ReactNode } from "react";
import { AppState } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { startBackgroundRefresh } from "~/lib/background";
import { persistOptions, queryClient } from "~/lib/cache";
import { PreferencesProvider, usePreferences } from "~/lib/preferences";
import { showPushesInForeground } from "~/lib/push";
import { PushProvider } from "~/lib/push-state";
import { SessionProvider, useSession } from "~/lib/session";
import { FONTS } from "~/lib/theme";

void SplashScreen.preventAutoHideAsync();

showPushesInForeground();

// React Query knows the browser's focus; on a phone, focus is the app being
// in the foreground.
focusManager.setEventListener((setFocused) => {
  const subscription = AppState.addEventListener("change", (state) => {
    setFocused(state === "active");
  });

  return () => subscription.remove();
});

/** Push registration needs the signed-in API, so it lives inside the gate. */
function SignedIn({ children }: { children: ReactNode }): JSX.Element {
  useEffect(() => {
    void startBackgroundRefresh();
  }, []);

  return <PushProvider>{children}</PushProvider>;
}

function Navigator(): JSX.Element | null {
  const { palette, dark, ready: preferencesReady } = usePreferences();
  const { ready: sessionReady, session } = useSession();
  // The splash screen stays up until the cache is back from disk, so the
  // first frame is last session's issues, not an empty list and a spinner.
  const restoring = useIsRestoring();

  // Sentry's two weights of Rubik, and Roboto Mono for code.
  const [fontsLoaded] = useFonts({
    Rubik_400Regular,
    Rubik_500Medium,
    RobotoMono_400Regular,
    RobotoMono_500Medium,
  });

  const ready = preferencesReady && sessionReady && fontsLoaded && !restoring;

  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(palette.bg);
  }, [palette.bg]);

  useEffect(() => {
    if (ready) {
      void SplashScreen.hideAsync();
    }
  }, [ready]);

  // A new sign-in must not show the previous account's cached issues. The
  // persister then writes the empty cache over the one on disk. Only once the
  // keystore has been read (until then, no session means not known yet) and
  // the restore is done (a cache restored after the clear would bring the
  // last account back, if the app closed before its sign-out was saved).
  useEffect(() => {
    if (sessionReady && !restoring && session === null) {
      queryClient.clear();
    }
  }, [sessionReady, restoring, session]);

  if (!ready) {
    return null;
  }

  const stack = (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: palette.bg },
        headerTintColor: palette.heading,
        headerTitleStyle: { fontFamily: FONTS.medium, fontSize: 16 },
        headerShadowVisible: false,
        contentStyle: { backgroundColor: palette.surface },
      }}
    >
      <Stack.Protected guard={session !== null}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        {/* The issue page draws its own breadcrumb row, as Sentry's does. */}
        <Stack.Screen name="issues/[id]/index" options={{ headerShown: false }} />
        <Stack.Screen name="issues/[id]/events" options={{ title: "Events" }} />
        <Stack.Screen name="notifications" options={{ title: "Notifications" }} />
        {/* The screen names itself once the monitor has loaded. */}
        <Stack.Screen name="monitors/[id]" options={{ title: "Monitor" }} />
      </Stack.Protected>
      <Stack.Protected guard={session === null}>
        <Stack.Screen name="pair" options={{ headerShown: false }} />
      </Stack.Protected>
    </Stack>
  );

  return (
    <>
      <StatusBar style={dark ? "light" : "dark"} />
      {session === null ? stack : <SignedIn>{stack}</SignedIn>}
    </>
  );
}

export default function RootLayout(): JSX.Element {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <PreferencesProvider>
          <SessionProvider>
            <PersistQueryClientProvider client={queryClient} persistOptions={persistOptions}>
              <Navigator />
            </PersistQueryClientProvider>
          </SessionProvider>
        </PreferencesProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
