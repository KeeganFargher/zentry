// The Monitors area's pages, one per URL under /:org/monitors/.

import type { JSX } from "react";

import type { MonitorView } from "~/lib/router";

import { AlertEditor } from "./alert-form";
import { AlertList } from "./alerts";
import { MonitorDetail } from "./detail";
import { CreateMonitor, EditMonitor } from "./form";
import { MonitorList } from "./list";
import { NewMonitor } from "./new";

export function MonitorsRoute({ org, view }: { org: string; view: MonitorView }): JSX.Element {
  switch (view.page) {
    case "list": {
      return <MonitorList org={org} kind={view.kind} />;
    }

    case "new": {
      return <NewMonitor org={org} />;
    }

    case "create": {
      return <CreateMonitor org={org} />;
    }

    case "detail": {
      return <MonitorDetail org={org} id={view.id} />;
    }

    case "edit": {
      return <EditMonitor org={org} id={view.id} />;
    }

    case "alerts": {
      return <AlertList org={org} />;
    }

    case "alert": {
      return <AlertEditor org={org} id={view.id} />;
    }

    default: {
      // Unreachable while every page is handled above; a new page without a
      // case fails to compile here instead of rendering nothing.
      const unhandled: never = view;

      throw new Error(`Unhandled monitors page: ${JSON.stringify(unhandled)}`);
    }
  }
}
