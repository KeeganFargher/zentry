// Every signed-in screen sits behind this: nothing that needs the organization
// in view renders until the user's organizations are known. A tapped push or
// a deep link can open an issue straight from a cold start, before the tabs
// have mounted, so the gate cannot live in the tab layout alone.

import type { JSX, ReactNode } from "react";
import { View } from "react-native";

import { useOrganizations } from "~/lib/organization";
import { usePalette } from "~/lib/preferences";

import { Notice } from "./basics";

export function OrgGate({ children }: { children: ReactNode }): JSX.Element {
  const palette = usePalette();
  const organizations = useOrganizations();

  if (organizations.current === null) {
    return (
      <View style={{ flex: 1, justifyContent: "center", backgroundColor: palette.surface }}>
        <Notice
          loading={organizations.loading}
          error={organizations.error}
          empty="You are not a member of any organization."
        />
      </View>
    );
  }

  return <>{children}</>;
}
