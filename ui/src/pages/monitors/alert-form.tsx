// Creating and editing an alert, as Sentry's automation builder: Source,
// Filter Issues, then one WHEN / IF / THEN block, the throttle and a name.
// Zentry's alerts have one block and send email or mobile push.

import type { ApiMonitor, ApiMonitorRule, Json, JsonObject } from "@contract";
import { useState } from "react";
import type { JSX } from "react";

import { Notice } from "~/components/basics";
import { Icon } from "~/components/icons";
import { api, ApiFailure } from "~/lib/api";
import { useResource } from "~/lib/resource";
import { navigate, useUrl } from "~/lib/router";
import { toast } from "~/lib/toast";

import { Builder } from "./alert-builder";
import type { Draft } from "./alert-builder";
import { bodyOf as monitorBody, draftOf } from "./form-state";
import { FormSection, TopBar, useMonitorContext } from "./parts";
import type { MonitorContext } from "./parts";

const NEW_RULE: Draft = {
  name: "",
  enabled: true,
  channels: ["email"],
  triggers: ["failure", "recovery"],
  throttleSeconds: 0,
  audience: { kind: "owner" },
};

/**
 * The rule's own settings, without the server's id, version and lastTriggered:
 * the API's rule schema is strict, so sending them fails every edit.
 */
function draftOfRule(rule: ApiMonitorRule): Draft {
  const { name, enabled, channels, triggers, throttleSeconds, audience, environment, priority } =
    rule;

  return { name, enabled, channels, triggers, throttleSeconds, audience, environment, priority };
}

function bodyOf(draft: Draft): Json {
  const { environment, priority, audience } = draft;

  // Sentry names an unnamed alert after what it does.
  const named =
    draft.name.trim() === "" ? `Notify via ${draft.channels.join(" and ")}` : draft.name;

  // Each field named, so nothing the form holds besides the rule reaches the API.
  const body: JsonObject = {
    name: named,
    enabled: draft.enabled,
    throttleSeconds: draft.throttleSeconds,
    channels: [...draft.channels],
    triggers: [...draft.triggers],
    audience:
      audience.kind === "members"
        ? { kind: "members", userIds: [...audience.userIds] }
        : { kind: audience.kind },
  };

  // JSON has no undefined, so unset filters are left out of the body.
  if (environment !== undefined) {
    body["environment"] = environment;
  }

  if (priority !== undefined) {
    body["priority"] = priority;
  }

  return body;
}

type Links = { linked: Set<string>; ruleId: string };

/**
 * Links live on each monitor, so each monitor whose link changed is saved
 * with its own version check and audit entry. The monitors are read fresh,
 * so a retry after a partial save diffs against what is stored now rather
 * than the versions the page loaded with.
 */
async function saveLinks(org: string, { linked, ruleId }: Links): Promise<void> {
  const monitors = await api.monitors(org);

  for (const monitor of monitors) {
    const has = monitor.alertRuleIds.includes(ruleId);

    if (has !== linked.has(monitor.id)) {
      const alertRuleIds = has
        ? monitor.alertRuleIds.filter((id) => id !== ruleId)
        : [...monitor.alertRuleIds, ruleId];

      await api.editMonitor(org, monitor, monitorBody({ ...draftOf(monitor), alertRuleIds }));
    }
  }
}

type Props = {
  org: string;
  context: MonitorContext;
  monitors: ApiMonitor[];
  rule: ApiMonitorRule | null;
};

function Source({
  monitors,
  linked,
  setLinked,
}: {
  monitors: ApiMonitor[];
  linked: Set<string>;
  setLinked: (linked: Set<string>) => void;
}): JSX.Element {
  const toggle = (id: string, on: boolean): void => {
    const next = new Set(linked);

    if (on) {
      next.add(id);
    } else {
      next.delete(id);
    }

    setLinked(next);
  };

  return (
    <FormSection
      title="Source"
      description="Get alerted when the issues of these monitors open, escalate or resolve."
    >
      <label className="check-label">
        <input type="radio" checked readOnly /> Alert on specific monitors
      </label>
      <ul className="rule-choices">
        {monitors.length === 0 && <li className="muted">No monitors yet.</li>}
        {monitors.map((monitor) => (
          <li key={monitor.id}>
            <label className="check-label">
              <input
                type="checkbox"
                checked={linked.has(monitor.id)}
                onChange={(event) => toggle(monitor.id, event.target.checked)}
              />{" "}
              {monitor.name}
            </label>
          </li>
        ))}
      </ul>
    </FormSection>
  );
}

function EnvironmentFilter({
  draft,
  set,
}: {
  draft: Draft;
  set: (draft: Draft) => void;
}): JSX.Element {
  return (
    <FormSection
      title="Filter Issues"
      description="Only get alerted on issues from this environment."
    >
      <input
        type="text"
        placeholder="All Environments"
        value={draft.environment ?? ""}
        onChange={(event) =>
          set({
            ...draft,
            environment: event.target.value.trim() === "" ? undefined : event.target.value,
          })
        }
      />
    </FormSection>
  );
}

type Saving = {
  save: (draft: Draft, linked: Set<string>) => Promise<void>;
  saving: boolean;
  error: string | null;
  /** The rule as last saved: the edited rule, or the one this form created. */
  saved: ApiMonitorRule | null;
};

/**
 * Saving an alert is two steps, the rule then each monitor's links, so a link
 * can fail after the rule exists. The created rule is kept, so a retry edits
 * it rather than creating a duplicate, and a save in flight blocks another.
 */
function useSaveRule({ org, context, rule }: Omit<Props, "monitors">): Saving {
  const [saved, setSaved] = useState(rule);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (draft: Draft, linked: Set<string>): Promise<void> => {
    setError(null);
    setSaving(true);

    try {
      const next =
        saved === null
          ? await api.createMonitorRule(org, bodyOf(draft))
          : await api.editMonitorRule(org, saved, bodyOf(draft));

      setSaved(next);
      await saveLinks(org, { linked, ruleId: next.id });
      toast(rule === null ? "Alert created" : "Alert saved");
      context.reloadRules();
      navigate(`/${org}/monitors/alerts/`);
    } catch (cause) {
      // Only the API's refusals are shown; anything else is a bug and surfaces.
      if (!(cause instanceof ApiFailure)) {
        throw cause;
      }

      setError(cause.message);
    } finally {
      setSaving(false);
    }
  };

  return { save, saving, error, saved };
}

function Editor({ org, context, monitors, rule }: Props): JSX.Element {
  const url = useUrl();
  const preset = url.searchParams.get("monitor");
  const [draft, setDraft] = useState<Draft>(rule === null ? NEW_RULE : draftOfRule(rule));

  // A new alert starts linked to the monitor it was created from, if any.
  const initial = new Set(
    monitors
      .filter(({ alertRuleIds, id }) =>
        rule === null ? id === preset : alertRuleIds.includes(rule.id),
      )
      .map(({ id }) => id),
  );

  const [linked, setLinked] = useState(initial);
  const { save, saving, error, saved } = useSaveRule({ org, context, rule });

  return (
    <>
      <TopBar crumbs={[{ label: "Alerts", to: `/${org}/monitors/alerts/` }]}>
        <label className="title-input">
          <input
            type="text"
            aria-label="Alert Name"
            placeholder="New Alert"
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          />
          <Icon name="edit" size={14} />
        </label>
      </TopBar>
      <div className="content monitor-form">
        {error !== null && <div className="alert-banner danger">{error}</div>}
        <Source monitors={monitors} linked={linked} setLinked={setLinked} />
        <EnvironmentFilter draft={draft} set={setDraft} />
        <Builder draft={draft} set={setDraft} context={context} />
      </div>
      <footer className="form-footer">
        <span className="spacer" />
        <button type="button" onClick={() => navigate(`/${org}/monitors/alerts/`)}>
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          disabled={saving}
          onClick={() => void save(draft, linked)}
        >
          {saved === null ? "Create Alert" : "Save"}
        </button>
      </footer>
    </>
  );
}

type LoadedProps = { org: string; id: string; context: MonitorContext; monitors: ApiMonitor[] };

/** An existing alert's editor, keyed by version so a newer save resets the form. */
function ExistingEditor({ org, id, context, monitors }: LoadedProps): JSX.Element {
  const rule = context.rules.find((entry) => entry.id === id);

  if (rule === undefined) {
    return <Notice loading={false} error="This alert does not exist." />;
  }

  return <Editor key={rule.version} org={org} context={context} monitors={monitors} rule={rule} />;
}

export function AlertEditor({ org, id }: { org: string; id: string | null }): JSX.Element {
  const context = useMonitorContext(org);
  const monitors = useResource(`monitors:${org}`, () => api.monitors(org));
  const data = context.data;

  if (data === null || monitors.data === null) {
    return (
      <Notice
        loading={context.loading || monitors.loading}
        error={context.error ?? monitors.error}
      />
    );
  }

  return id === null ? (
    <Editor key="new" org={org} context={data} monitors={monitors.data} rule={null} />
  ) : (
    <ExistingEditor org={org} id={id} context={data} monitors={monitors.data} />
  );
}
