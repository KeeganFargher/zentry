// The application shell: sidebar plus whichever page the URL names.

import type { ApiMe } from "@contract";
import { useEffect, useState } from "react";
import type { JSX } from "react";

import { Notice } from "~/components/basics";
import { Rail, SubNav } from "~/components/nav";
import type { Section } from "~/components/nav";
import { Toasts } from "~/components/overlays";
import { api } from "~/lib/api";
import { useResource } from "~/lib/resource";
import { matchRoute, navigate, useUrl } from "~/lib/router";
import type { Route } from "~/lib/router";
import { CliSettings } from "~/pages/cli-settings";
import { IssueDetail } from "~/pages/issue-detail";
import { IssueEvents } from "~/pages/issue-events";
import { IssueList } from "~/pages/issue-list";
import { MobileSettings } from "~/pages/mobile-settings";
import { MonitorsRoute } from "~/pages/monitors/route";
import { NotificationSettings } from "~/pages/notification-settings";
import { OrganizationSettings } from "~/pages/organization-settings";
import { ProjectSettings } from "~/pages/project-settings";
import { Projects } from "~/pages/projects";

function Page({ route }: { route: Route }): JSX.Element {
  switch (route.name) {
    case "issues": {
      return <IssueList org={route.org} />;
    }

    case "issue": {
      return <IssueDetail org={route.org} issueId={route.issueId} eventId={route.eventId} />;
    }

    case "events": {
      return <IssueEvents org={route.org} issueId={route.issueId} />;
    }

    case "monitors": {
      return <MonitorsRoute org={route.org} view={route.view} />;
    }

    case "projects": {
      return <Projects org={route.org} />;
    }

    default: {
      return <SettingsPage route={route} />;
    }
  }
}

/** The pages under /:org/settings/, split from Page to keep each switch small. */
function SettingsPage({ route }: { route: Route }): JSX.Element {
  switch (route.name) {
    case "settings": {
      return <ProjectSettings org={route.org} project={route.project} />;
    }

    case "organizationSettings": {
      return <OrganizationSettings org={route.org} />;
    }

    case "notificationSettings": {
      return <NotificationSettings org={route.org} />;
    }

    case "mobileSettings": {
      return <MobileSettings />;
    }

    case "cliSettings": {
      return <CliSettings org={route.org} />;
    }

    default: {
      return <div className="notice">Page not found.</div>;
    }
  }
}

function sectionOf(route: Route): Section {
  if (route.name === "issues" || route.name === "issue" || route.name === "events") {
    return "issues";
  }

  return route.name === "monitors" ? "monitors" : "projects";
}

type ShellProps = { org: string; route: Route; me: ApiMe; location: string };

function Shell({ org, route, me, location }: ShellProps): JSX.Element {
  // The side navigation, opened over the page on a narrow screen, belongs to the
  // page it was opened on and so closes on navigation.
  const [menuAt, setMenuAt] = useState<string | null>(null);
  const menu = menuAt === location;
  const projects = useResource(`projects:${org}`, () => api.projects(org));

  return (
    <div className={menu ? "shell menu-open" : "shell"}>
      <Rail
        org={org}
        section={sectionOf(route)}
        me={me}
        onMenu={() => setMenuAt(menu ? null : location)}
      />
      <SubNav org={org} section={sectionOf(route)} projects={projects.data ?? []} />
      {menu && <div className="scrim" onClick={() => setMenuAt(null)} />}
      <main className="main">
        <Page route={route} />
      </main>
      <Toasts />
    </div>
  );
}

export function App(): JSX.Element {
  const url = useUrl();
  const route = matchRoute(url.pathname);
  const me = useResource("me", api.me);
  const home = me.data?.organizations[0]?.slug ?? null;
  const org = "org" in route ? route.org : home;

  useEffect(() => {
    if (route.name === "home" && home !== null) {
      navigate(`/${home}/issues/`);
    }
  }, [route.name, home]);

  if (me.data === null || org === null) {
    return (
      <Notice
        loading={me.loading}
        error={me.error}
        empty="You are not a member of any organization."
      />
    );
  }

  return <Shell org={org} route={route} me={me.data} location={url.pathname + url.search} />;
}
