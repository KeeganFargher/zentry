// A monitor's issue has no events, only its monitor's results. On the web its
// page is the monitor's page; here it links there, so a push about a failing
// cron leads to its timeline and check-ins in one tap.

import { useRouter } from "expo-router";
import type { JSX } from "react";
import { View } from "react-native";

import { Button } from "~/components/button";
import { SPACE } from "~/lib/theme";

export function MonitorLink({ monitorId }: { monitorId: string }): JSX.Element {
  const router = useRouter();

  return (
    <View style={{ paddingHorizontal: SPACE.lg, paddingTop: SPACE.md }}>
      <Button
        label="View monitor"
        icon="monitors"
        onPress={() => router.push({ pathname: "/monitors/[id]", params: { id: monitorId } })}
      />
    </View>
  );
}
