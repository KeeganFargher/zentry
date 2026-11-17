// The two navigation columns: an icon rail for the sections, and beside it
// the links within the current section.

import type { ApiMe, ApiProject } from "@contract";
import type { JSX } from "react";

import { Link, Platform } from "~/components/basics";
import { Icon } from "~/components/icons";
import type { IconName } from "~/components/icons";
import { useUrl } from "~/lib/router";
import { useTheme } from "~/lib/theme";

export type Section = "issues" | "projects";

type RailProps = { org: string; section: Section; me: ApiMe; onMenu: () => void };

type RailLinkProps = { to: string; icon: IconName; label: string; active: boolean };

function RailLink({ to, icon, label, active }: RailLinkProps): JSX.Element {
  return (
    <Link to={to} className={active ? "active" : ""}>
      <span className="icon-box">
        <Icon name={icon} size={18} />
      </span>
      {label}
    </Link>
  );
}

function initials(email: string): string {
  const [name = ""] = email.split("@");
  const parts = name.split(/[._-]+/).filter((part) => part !== "");
  const letters = parts.length > 1 ? `${parts[0]?.[0]}${parts[1]?.[0]}` : name.slice(0, 2);

  return letters.toUpperCase();
}

function ThemeToggle(): JSX.Element {
  const [theme, toggle] = useTheme();
  const label = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";

  return (
    <button type="button" aria-label={label} title={label} onClick={toggle}>
      <Icon name={theme === "dark" ? "sun" : "moon"} size={18} />
    </button>
  );
}

// The organization is in every URL but there is no switcher while there is only one.
export function Rail({ org, section, me, onMenu }: RailProps): JSX.Element {
  const name = me.organizations.find((entry) => entry.slug === org)?.name ?? org;

  return (
    <nav className="rail" aria-label="Sections">
      <div className="org-tile" title={name}>
        {name.slice(0, 1).toUpperCase()}
      </div>
      <button type="button" className="menu-toggle" aria-label="Show navigation" onClick={onMenu}>
        <Icon name="menu" size={18} />
      </button>
      <RailLink to={`/${org}/issues/`} icon="issues" label="Issues" active={section === "issues"} />
      <RailLink
        to={`/${org}/projects/`}
        icon="projects"
        label="Projects"
        active={section === "projects"}
      />
      <span className="spacer" />
      <ThemeToggle />
      <div className="avatar" title={me.email}>
        {initials(me.email)}
      </div>
    </nav>
  );
}

type SubNavProps = { org: string; section: Section; projects: ApiProject[] };

type SubLinkProps = { to: string; label: string; platform?: string | null };

function SubLink({ to, label, platform }: SubLinkProps): JSX.Element {
  const url = useUrl();
  const [path = "", query = ""] = to.split("?");
  const current = url.pathname === path && url.searchParams.toString() === query;

  return (
    <Link to={to} className={current ? "active" : ""}>
      {platform !== undefined && <Platform name={platform} />}
      <span className="clip">{label}</span>
    </Link>
  );
}

function IssueLinks({ org, projects }: Omit<SubNavProps, "section">): JSX.Element {
  const base = `/${org}/issues/`;

  return (
    <>
      <div className="subnav-group">
        <SubLink to={base} label="Feed" />
      </div>
      <div className="subnav-group">
        <SubLink to={`${base}?level=error`} label="Errors" />
        <SubLink to={`${base}?level=warning`} label="Warnings" />
        <SubLink to={`${base}?status=resolved`} label="Resolved" />
        <SubLink to={`${base}?status=ignored`} label="Archived" />
        <SubLink to={`${base}?status=all`} label="All Issues" />
      </div>
      <div className="subnav-group">
        <div className="subnav-label">Projects</div>
        {projects.map((project) => (
          <SubLink
            key={project.id}
            to={`${base}?project=${project.id}`}
            label={project.name}
            platform={project.platform}
          />
        ))}
      </div>
    </>
  );
}

function ProjectLinks({ org, projects }: Omit<SubNavProps, "section">): JSX.Element {
  return (
    <>
      <div className="subnav-group">
        <SubLink to={`/${org}/projects/`} label="All projects" />
      </div>
      <div className="subnav-group">
        <div className="subnav-label">Settings</div>
        <SubLink to={`/${org}/settings/`} label="Spend limits" />
        {projects.map((project) => (
          <SubLink
            key={project.id}
            to={`/${org}/settings/projects/${project.slug}/`}
            label={project.name}
          />
        ))}
      </div>
    </>
  );
}

export function SubNav({ org, section, projects }: SubNavProps): JSX.Element {
  return (
    <nav className="subnav" aria-label={section}>
      <div className="subnav-title">{section === "issues" ? "Issues" : "Projects"}</div>
      {section === "issues" ? (
        <IssueLinks org={org} projects={projects} />
      ) : (
        <ProjectLinks org={org} projects={projects} />
      )}
    </nav>
  );
}
