// Who this phone is signed in as, whether pushes reach it, how it looks, and
// signing out. Spend limits, projects and DSN keys stay in the web UI.

import { useRouter } from "expo-router";
import type { JSX } from "react";
import { Alert, Linking, Pressable, ScrollView, View } from "react-native";

import { Fact, Panel } from "~/components/basics";
import { Button } from "~/components/button";
import { Icon } from "~/components/icons";
import { Segmented } from "~/components/segmented";
import { SectionTitle, Text } from "~/components/text";
import { ApiFailure } from "~/lib/api";
import { useOrganizations } from "~/lib/organization";
import { usePreferences } from "~/lib/preferences";
import type { ThemeChoice } from "~/lib/preferences";
import { usePush } from "~/lib/push-state";
import { useApi, useSession } from "~/lib/session";
import type { Session } from "~/lib/session";
import { SPACE } from "~/lib/theme";

const THEMES: [ThemeChoice, string][] = [
  ["system", "System"],
  ["light", "Light"],
  ["dark", "Dark"],
];

function PushStatus(): JSX.Element {
  const { state, retry } = usePush();

  if (state === null) {
    return <Text tone="muted">Registering for push notifications…</Text>;
  }

  if (state.status === "on") {
    return <Text tone="ok">Push notifications are on for this phone.</Text>;
  }

  if (state.status === "denied") {
    return (
      <View style={{ gap: SPACE.sm }}>
        <Text>Notifications are turned off for Zentry in Android settings.</Text>
        <Button label="Open Android settings" onPress={() => void Linking.openSettings()} />
      </View>
    );
  }

  return (
    <View style={{ gap: SPACE.sm }}>
      <Text tone="danger">Push notifications are not working: {state.error}</Text>
      <Button label="Try again" onPress={retry} />
    </View>
  );
}

function Organizations(): JSX.Element | null {
  const { all, current, choose } = useOrganizations();

  if (all.length < 2) {
    return null;
  }

  return (
    <Panel>
      <SectionTitle>Organization</SectionTitle>
      {all.map((organization) => (
        <Pressable key={organization.id} onPress={() => choose(organization.slug)}>
          <Text tone={organization.id === current?.id ? "link" : "text"} weight="medium">
            {organization.name}
          </Text>
        </Pressable>
      ))}
    </Panel>
  );
}

/**
 * Deletes this phone's device row first, which ends its token and pushes on
 * the server, then forgets the token here. When the server cannot be
 * reached, the user decides whether to forget it here anyway; the web UI can
 * still sign the phone out later.
 */
function useSignOut(session: Session): () => void {
  const api = useApi();
  const { signOut } = useSession();

  return () => {
    api
      .removeDevice(session.deviceId)
      .then(signOut)
      .catch((cause: unknown) => {
        // Already signed out on the server: the 401 has signed the app out too.
        if (cause instanceof ApiFailure && cause.status === 401) {
          return;
        }

        Alert.alert(
          "Could not sign out on the server",
          `${cause instanceof Error ? cause.message : "The request failed"}. Forget the sign-in on this phone anyway? It stays listed in the web UI until you sign it out there.`,
          [
            { text: "Cancel", style: "cancel" },
            { text: "Forget here", style: "destructive", onPress: () => void signOut() },
          ],
        );
      });
  };
}

function Account({ session }: { session: Session }): JSX.Element {
  const signOut = useSignOut(session);

  return (
    <Panel>
      <SectionTitle>Account</SectionTitle>
      <Fact label="Signed in as" value={session.email} />
      <Fact label="Server" value={new URL(session.apiUrl).host} />
      <Button label="Sign out" kind="danger" onPress={signOut} />
    </Panel>
  );
}

export function SettingsScreen(): JSX.Element {
  const router = useRouter();
  const { session } = useSession();
  const { theme, setTheme } = usePreferences();

  if (session === null) {
    throw new Error("Settings shown while signed out");
  }

  return (
    <ScrollView contentContainerStyle={{ padding: SPACE.md, gap: SPACE.md }}>
      <Panel>
        <SectionTitle>Notifications</SectionTitle>
        <PushStatus />
        <Pressable
          onPress={() => router.push("/notifications")}
          style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}
        >
          <Text tone="link" weight="medium">
            Choose what to get, by push and by email
          </Text>
          <Icon name="next" />
        </Pressable>
      </Panel>
      <Organizations />
      <Panel>
        <SectionTitle>Appearance</SectionTitle>
        <Segmented label="Theme" options={THEMES} value={theme} onChange={setTheme} />
      </Panel>
      <Account session={session} />
    </ScrollView>
  );
}
