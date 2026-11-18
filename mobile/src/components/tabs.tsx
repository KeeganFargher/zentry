// Sentry's tabs: plain labels on a divider, the chosen one in the accent
// colour over a 3px accent underline.

import type { JSX, ReactNode } from "react";
import { Pressable, View } from "react-native";

import { usePalette } from "~/lib/preferences";
import { CONTROL, SPACE } from "~/lib/theme";

import { Text } from "./text";

type TabsProps<T extends string> = {
  tabs: readonly (readonly [value: T, label: string])[];
  value: T;
  onChange: (value: T) => void;
  /** Sits at the right end of the tab row, as Sentry's "All Events" link. */
  trailing?: ReactNode;
};

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  trailing,
}: TabsProps<T>): JSX.Element {
  const palette = usePalette();

  return (
    <View
      accessibilityRole="tablist"
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: SPACE.xs,
        paddingHorizontal: SPACE.md,
        borderBottomWidth: 1,
        borderBottomColor: palette.borderSoft,
      }}
    >
      {tabs.map(([tab, label]) => {
        const chosen = tab === value;

        return (
          <Pressable
            key={tab}
            accessibilityRole="tab"
            accessibilityState={{ selected: chosen }}
            onPress={() => onChange(tab)}
            style={{
              height: CONTROL.touch,
              paddingHorizontal: SPACE.sm,
              justifyContent: "center",
              borderBottomWidth: 3,
              borderBottomColor: chosen ? palette.accent : "transparent",
            }}
          >
            <Text weight={chosen ? "medium" : "regular"} tone={chosen ? "link" : "muted"}>
              {label}
            </Text>
          </Pressable>
        );
      })}
      {trailing !== undefined && <View style={{ marginLeft: "auto" }}>{trailing}</View>}
    </View>
  );
}
