// Pieces shared by every monitor page: the top bar, sections and badges, in
// the shape of Sentry's workflowEngine layout (DetailSection, FormSection).

import type { ApiMonitor, ApiMonitorRule, ApiProject, MonitorMember } from "@contract";
import { useState } from "react";
import type { JSX, ReactNode } from "react";

import { Link, Platform } from "~/components/basics";
import { Icon } from "~/components/icons";
import { api } from "~/lib/api";
import { useResource } from "~/lib/resource";
import type { Resource } from "~/lib/resource";

export type Crumb = { label: string; to?: string };

/** Sentry's top bar: breadcrumbs, then the page title, then actions on the right. */
export function TopBar({
  crumbs,
  children,
}: {
  crumbs: Crumb[];
  children?: ReactNode;
}): JSX.Element {
  return (
    <header className="topbar">
      {crumbs.map((crumb, index) => (
        <span key={crumb.label} className="crumb-item">
          {index > 0 && <span className="sep">/</span>}
          {crumb.to === undefined ? (
            <h1>{crumb.label}</h1>
          ) : (
            <Link to={crumb.to}>{crumb.label}</Link>
          )}
        </span>
      ))}
      {/* Children are the editable last crumb, as Sentry's "New Monitor ✎" title. */}
      {children !== undefined && (
        <span className="crumb-item">
          <span className="sep">/</span>
          {children}
        </span>
      )}
      <span className="spacer" />
    </header>
  );
}

/** A section of a detail page: an h3 title, actions on its right, then content. */
export function DetailSection(props: {
  title: ReactNode;
  trailing?: ReactNode;
  description?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="detail-section">
      <div className="detail-section-head">
        <h3>{props.title}</h3>
        {props.trailing}
      </div>
      {props.description !== undefined && <p className="muted">{props.description}</p>}
      {props.children}
    </section>
  );
}

/** A numbered, collapsible form section, open by default. */
export function FormSection(props: {
  step?: number;
  title: string;
  description?: ReactNode;
  trailing?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(true);
  const heading = props.step === undefined ? props.title : `${props.step}. ${props.title}`;

  return (
    <section className="form-section panel">
      <div className="form-section-head">
        <button
          type="button"
          className="plain form-section-toggle"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <span className={open ? "chevron open" : "chevron"}>
            <Icon name="chevron" size={14} />
          </span>
          <h3>{heading}</h3>
        </button>
        {props.trailing}
      </div>
      {open && (
        <div className="form-section-body">
          {props.description !== undefined && <p className="muted">{props.description}</p>}
          {props.children}
        </div>
      )}
    </section>
  );
}

/**
 * A labelled control in a form section: label and help on the left, control on
 * the right. A <label> so its first control takes the field's name, which
 * screen readers and tests rely on; further controls carry their own aria-label.
 */
export function Field(props: {
  label: string;
  help?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <label className="form-field">
      <div className="form-field-label">
        <span>{props.label}</span>
        {props.help !== undefined && <span className="muted small">{props.help}</span>}
      </div>
      <div className="form-field-control">{props.children}</div>
    </label>
  );
}

export function ProjectBadge({ project }: { project: ApiProject | undefined }): JSX.Element {
  return (
    <span className="project-badge">
      <Platform name={project?.platform ?? null} />
      {project?.slug ?? "unknown project"}
    </span>
  );
}

/** Sentry's PriorityDot: red for high, amber for medium, green for resolved. */
export function PriorityDot({
  priority,
}: {
  priority: "high" | "medium" | "resolved";
}): JSX.Element {
  return <span className={`priority-dot ${priority}`} aria-hidden="true" />;
}

export type MonitorContext = {
  projects: ApiProject[];
  members: MonitorMember[];
  rules: ApiMonitorRule[];
  reloadRules: () => void;
};

/** What most monitor pages need besides the monitors themselves. */
export function useMonitorContext(org: string): Resource<MonitorContext> {
  const projects = useResource(`projects:${org}`, () => api.projects(org));
  const members = useResource(`monitor-members:${org}`, () => api.monitorMembers(org));
  const rules = useResource(`monitor-rules:${org}`, () => api.monitorRules(org));

  const loaded =
    projects.data !== null && members.data !== null && rules.data !== null
      ? {
          projects: projects.data,
          members: members.data,
          rules: rules.data,
          reloadRules: rules.reload,
        }
      : null;

  return {
    data: loaded,
    loading: projects.loading || members.loading || rules.loading,
    error: projects.error ?? members.error ?? rules.error,
    reload: () => {
      projects.reload();
      members.reload();
      rules.reload();
    },
  };
}

/** A member's email, or null once they have left the organization. */
export function memberEmail(members: MonitorMember[], userId: number): string | null {
  return members.find((member) => member.userId === userId)?.email ?? null;
}

export function projectOf(projects: ApiProject[], monitor: ApiMonitor): ApiProject | undefined {
  return projects.find((project) => project.id === monitor.projectId);
}
