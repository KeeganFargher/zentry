import type { JSX } from "react";

import { OrgGate } from "~/components/org-gate";
import { IssueScreen } from "~/screens/issue/screen";

export default function Screen(): JSX.Element {
  return (
    <OrgGate>
      <IssueScreen />
    </OrgGate>
  );
}
