// The three tabs, behind the organization gate (components/org-gate.tsx).

import { Tabs } from "expo-router";
import type { JSX } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Icon } from "~/components/icons";
import type { IconName } from "~/components/icons";
import { OrgGate } from "~/components/org-gate";
import { UpdateToast } from "~/components/update-toast";
import { usePalette } from "~/lib/preferences";
import { FONTS, RADIUS, SPACE } from "~/lib/theme";

/**
 * React Navigation's own tab bar height on a phone held upright (the app is
 * portrait only), set here so the update toast can sit just above it.
 */
const TAB_BAR = 49;

/** The focused tab's icon sits on a raised accent pill, as Sentry's nav does. */
function TabIcon({ name, focused }: { name: IconName; focused: boolean }): JSX.Element {
  const palette = usePalette();

  return (
    <View
      style={{
        width: 40,
        height: 30,
        borderRadius: RADIUS.md,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: focused ? palette.accentSoft : "transparent",
        borderWidth: 1,
        borderColor: focused ? palette.accentLine : "transparent",
        borderBottomWidth: focused ? 3 : 1,
      }}
    >
      <Icon name={name} color={focused ? palette.link : palette.muted} size={18} />
    </View>
  );
}

function tabIcon(name: IconName): (props: { focused: boolean }) => JSX.Element {
  return ({ focused }) => <TabIcon name={name} focused={focused} />;
}

function OrganizationTabs(): JSX.Element {
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const tabBar = TAB_BAR + insets.bottom;

  return (
    <View style={{ flex: 1 }}>
      <Tabs
        screenOptions={{
          headerStyle: { backgroundColor: palette.bg },
          headerTintColor: palette.heading,
          headerTitleStyle: { fontFamily: FONTS.medium, fontSize: 16 },
          headerShadowVisible: false,
          tabBarStyle: {
            height: tabBar,
            backgroundColor: palette.bg,
            borderTopColor: palette.borderSoft,
          },
          tabBarItemStyle: { paddingTop: 6 },
          tabBarActiveTintColor: palette.link,
          tabBarInactiveTintColor: palette.text,
          tabBarLabelStyle: { fontFamily: FONTS.regular, fontSize: 11 },
          sceneStyle: { backgroundColor: palette.surface },
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            // The list draws its own title and organization, as Sentry's page header.
            headerShown: false,
            tabBarLabel: "Issues",
            tabBarIcon: tabIcon("issues"),
          }}
        />
        <Tabs.Screen
          name="monitors"
          options={{ title: "Monitors", tabBarIcon: tabIcon("monitors") }}
        />
        <Tabs.Screen
          name="projects"
          options={{ title: "Projects", tabBarIcon: tabIcon("projects") }}
        />
        <Tabs.Screen
          name="settings"
          options={{ title: "Settings", tabBarIcon: tabIcon("settings") }}
        />
      </Tabs>
      {/* Here, not in the root: pushed screens cover it, and it waits for you. */}
      <UpdateToast bottom={tabBar + SPACE.sm} />
    </View>
  );
}

export default function TabsLayout(): JSX.Element {
  return (
    <OrgGate>
      <OrganizationTabs />
    </OrgGate>
  );
}
