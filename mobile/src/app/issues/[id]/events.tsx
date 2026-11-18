import type { JSX } from "react";

import { OrgGate } from "~/components/org-gate";
import { EventsScreen } from "~/screens/issue/events";

export default function Screen(): JSX.Element {
  return (
    <OrgGate>
      <EventsScreen />
    </OrgGate>
  );
}
