// The three tabs, behind the organization gate (components/org-gate.tsx).

import { Tabs } from "expo-router";
import type { JSX } from "react";
import { View } from "react-native";

import { Icon } from "~/components/icons";
import type { IconName } from "~/components/icons";
import { OrgGate } from "~/components/org-gate";
import { usePalette } from "~/lib/preferences";
import { FONTS, RADIUS } from "~/lib/theme";

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

  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: palette.bg },
        headerTintColor: palette.heading,
        headerTitleStyle: { fontFamily: FONTS.medium, fontSize: 16 },
        headerShadowVisible: false,
        tabBarStyle: { backgroundColor: palette.bg, borderTopColor: palette.borderSoft },
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
        name="projects"
        options={{ title: "Projects", tabBarIcon: tabIcon("projects") }}
      />
      <Tabs.Screen
        name="settings"
        options={{ title: "Settings", tabBarIcon: tabIcon("settings") }}
      />
    </Tabs>
  );
}

export default function TabsLayout(): JSX.Element {
  return (
    <OrgGate>
      <OrganizationTabs />
    </OrgGate>
  );
}
