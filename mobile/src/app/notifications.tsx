import type { JSX } from "react";

import { OrgGate } from "~/components/org-gate";
import { NotificationsScreen } from "~/screens/notifications";

export default function Screen(): JSX.Element {
  return (
    <OrgGate>
      <NotificationsScreen />
    </OrgGate>
  );
}
