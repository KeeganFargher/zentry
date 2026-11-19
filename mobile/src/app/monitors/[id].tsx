import type { JSX } from "react";

import { OrgGate } from "~/components/org-gate";
import { MonitorScreen } from "~/screens/monitors/detail";

export default function Screen(): JSX.Element {
  return (
    <OrgGate>
      <MonitorScreen />
    </OrgGate>
  );
}
