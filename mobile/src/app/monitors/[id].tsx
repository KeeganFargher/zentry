import type { JSX } from "react";

import { OrgGate } from "~/components/org-gate";
import { RouteError } from "~/components/route-error";
import { MonitorScreen } from "~/screens/monitors/detail";

export { RouteError as ErrorBoundary };

export default function Screen(): JSX.Element {
  return (
    <OrgGate>
      <MonitorScreen />
    </OrgGate>
  );
}
