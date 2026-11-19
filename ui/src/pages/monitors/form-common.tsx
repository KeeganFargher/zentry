// Form sections every monitor type has: project, ownership, the sample
// issue, and connected alerts (Sentry's projectSection,
// issueOwnershipSection, issuePreviewSection and automateSection).

import type { ApiMonitorRule, NewMonitor } from "@contract";
import { useState } from "react";
import type { JSX, ReactNode } from "react";

import { Icon } from "~/components/icons";
import { useNow } from "~/lib/clock";
import { minuteTime } from "~/lib/format";

import { Field, FormSection } from "./parts";
import type { MonitorContext } from "./parts";

export type SectionProps<T extends NewMonitor = NewMonitor> = {
  draft: T;
  set: (draft: NewMonitor) => void;
  context: MonitorContext;
  /** Projects are fixed after creation. */
  editing: boolean;
};

export function ProjectSection({
  step,
  draft,
  set,
  context,
  editing,
  children,
}: SectionProps & { step: number; children?: ReactNode }): JSX.Element {
  const environment = draft.type === "cron" ? null : (draft.config.environment ?? "");

  const setEnvironment = (value: string): void => {
    const next = value.trim() === "" ? undefined : value.trim();

    if (draft.type === "uptime") {
      set({ ...draft, config: { ...draft.config, environment: next } });
    } else if (draft.type === "metric") {
      set({ ...draft, config: { ...draft.config, environment: next } });
    }
  };

  return (
    <FormSection
      step={step}
      title={environment === null ? "Choose a Project" : "Choose the Project and Environment"}
      description="This is where issues will be created."
    >
      <div className="field-row">
        <label>
          Project
          <select
            value={draft.projectId}
            disabled={editing}
            onChange={(event) => set({ ...draft, projectId: Number(event.target.value) })}
          >
            {context.projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.slug}
              </option>
            ))}
          </select>
        </label>
        {environment !== null && (
          <label>
            Environment
            <input
              type="text"
              placeholder="All Environments"
              value={environment}
              onChange={(event) => setEnvironment(event.target.value)}
            />
          </label>
        )}
      </div>
      {draft.type === "cron" && (
        <p className="muted small">
          Each environment a check-in names is tracked separately, and appears with its first
          check-in.
        </p>
      )}
      {children}
    </FormSection>
  );
}

export function OwnershipSection({
  step,
  draft,
  set,
  context,
}: SectionProps & { step: number }): JSX.Element {
  return (
    <FormSection step={step} title="Issue Ownership">
      <Field
        label="Assign"
        help="Zentry will assign issues detected by this monitor to this member."
      >
        <select
          value={draft.ownerId ?? ""}
          onChange={(event) =>
            set({
              ...draft,
              ownerId: event.target.value === "" ? null : Number(event.target.value),
            })
          }
        >
          <option value="">Select a member</option>
          {context.members.map((member) => (
            <option key={member.userId} value={member.userId}>
              {member.email}
            </option>
          ))}
        </select>
      </Field>
      <Field
        label="Describe"
        help="Add any additional context about this monitor for other team members."
      >
        <textarea
          rows={5}
          placeholder={
            "Example monitor description\n\nTo debug follow these steps:\n1. …\n2. …\n3. …"
          }
          value={draft.description}
          onChange={(event) => set({ ...draft, description: event.target.value })}
        />
      </Field>
    </FormSection>
  );
}

const SUBTITLES: Record<NewMonitor["type"], string> = {
  cron: "Your monitor is failing: A missed check-in was detected",
  uptime: "Your monitored domain is down",
  metric: "Critical: Number of errors above the threshold",
};

export function IssuePreviewSection({
  step,
  draft,
  context,
}: Omit<SectionProps, "set" | "editing"> & { step: number }): JSX.Element {
  const now = useNow();
  const project = context.projects.find(({ id }) => id === draft.projectId);
  const name = draft.name.trim() === "" ? "New Monitor" : draft.name;

  return (
    <FormSection
      step={step}
      title="Preview"
      description="Given your configurations, this is a sample of the kind of issue you can expect this Monitor to produce."
    >
      <table className="rows panel">
        <thead>
          <tr>
            <th>Issue</th>
            <th>Last Seen</th>
            <th>Events</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <strong>{draft.type === "cron" ? `Cron failure: ${name}` : name}</strong>
              <div className="muted small">{SUBTITLES[draft.type]}</div>
              <div className="muted small">{(project?.slug ?? "project").toUpperCase()}-1</div>
            </td>
            <td>{minuteTime(now)}</td>
            <td>1</td>
          </tr>
        </tbody>
      </table>
    </FormSection>
  );
}

function LinkedRules({ linked }: { linked: ApiMonitorRule[] }): JSX.Element | null {
  if (linked.length === 0) {
    return null;
  }

  return (
    <table className="rows">
      <thead>
        <tr>
          <th>Name</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {linked.map((rule) => (
          <tr key={rule.id}>
            <td>{rule.name}</td>
            <td>{rule.channels.join(", ")}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RuleChoices({
  rules,
  chosen,
  toggle,
}: {
  rules: ApiMonitorRule[];
  chosen: string[];
  toggle: (id: string, on: boolean) => void;
}): JSX.Element {
  return (
    <ul className="rule-choices">
      {rules.length === 0 && <li className="muted">No alerts yet.</li>}
      {rules.map((rule) => (
        <li key={rule.id}>
          <label className="check-label">
            <input
              type="checkbox"
              checked={chosen.includes(rule.id)}
              onChange={(event) => toggle(rule.id, event.target.checked)}
            />{" "}
            {rule.name}
          </label>
        </li>
      ))}
    </ul>
  );
}

export function AlertsSection({
  step,
  draft,
  set,
  context,
  org,
}: SectionProps & { step: number; org: string }): JSX.Element {
  const [choosing, setChoosing] = useState(false);
  const linked = context.rules.filter(({ id }) => draft.alertRuleIds.includes(id));

  const toggle = (id: string, on: boolean): void =>
    set({
      ...draft,
      alertRuleIds: on
        ? [...draft.alertRuleIds, id]
        : draft.alertRuleIds.filter((linkedId) => linkedId !== id),
    });

  const choose = (): void => {
    // An alert created in the other tab appears when the list opens again.
    context.reloadRules();
    setChoosing(!choosing);
  };

  return (
    <FormSection
      step={step}
      title="Alert"
      description="Configure alerting on this Monitor to get notified on issues."
    >
      <div id="alerts" className="panel alert-links">
        <LinkedRules linked={linked} />
        <div className="empty-state">
          <button type="button" onClick={choose}>
            {linked.length > 0 ? "Edit Connected Alerts" : "Connect Existing Alerts"}
          </button>
          {/* A new tab, so the monitor being written here is not lost. */}
          <a
            href={`/${org}/monitors/alerts/new/`}
            target="_blank"
            rel="noreferrer"
            className="button-link"
          >
            <Icon name="add" size={14} /> Create New Alert
          </a>
        </div>
        {choosing && (
          <RuleChoices rules={context.rules} chosen={draft.alertRuleIds} toggle={toggle} />
        )}
      </div>
      <label className="check-label">
        <input
          type="checkbox"
          checked={draft.notify}
          onChange={(event) => set({ ...draft, notify: event.target.checked })}
        />{" "}
        Send notifications through connected alerts
      </label>
    </FormSection>
  );
}
