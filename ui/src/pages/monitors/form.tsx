// Step 2 of creating a monitor, and editing one: Sentry's new/edit detector
// layout with an editable title in the top bar, a sticky preview, numbered
// sections and a footer of actions.

import type { NewMonitor } from "@contract";
import { useState } from "react";
import type { JSX } from "react";

import { Notice } from "~/components/basics";
import { Icon } from "~/components/icons";
import { api } from "~/lib/api";
import { TYPE_LABELS } from "~/lib/monitor-text";
import { useResource } from "~/lib/resource";
import { navigate, useUrl } from "~/lib/router";
import { toast } from "~/lib/toast";

import {
  AlertsSection,
  IssuePreviewSection,
  OwnershipSection,
  ProjectSection,
} from "./form-common";
import type { SectionProps } from "./form-common";
import { CronDetection, CronResolution, Instrumentation } from "./form-cron";
import { FormFooter } from "./form-footer";
import type { Mode } from "./form-footer";
import { useProblems, ValidityProvider } from "./form-inputs";
import { MetricChoice, MetricDetection } from "./form-metric";
import { MetricPreview, SchedulePreview } from "./form-preview";
import { bodyOf, draftOf, newDraft } from "./form-state";
import { slugify } from "./form-state";
import type { MonitorType } from "./form-state";
import { UptimeDetection, UptimeResolution, UptimeVerification } from "./form-uptime";
import { Field, TopBar, useMonitorContext } from "./parts";
import type { MonitorContext } from "./parts";
import { dsnStateOf } from "./sdk-guide";
import type { DsnState } from "./sdk-guide";

type FormProps = { org: string; context: MonitorContext; mode: Mode; initial: NewMonitor };

/** The type's sections after the project section, numbered as Sentry numbers them. */
function Sections({ props }: { props: SectionProps & { org: string } }): JSX.Element {
  const { draft } = props;

  const detection =
    draft.type === "cron" ? (
      <>
        <CronDetection {...props} draft={draft} step={2} />
        <CronResolution {...props} draft={draft} step={3} />
      </>
    ) : draft.type === "uptime" ? (
      <>
        <UptimeDetection {...props} draft={draft} step={2} />
        <UptimeVerification {...props} draft={draft} step={3} />
        <UptimeResolution {...props} draft={draft} step={4} />
      </>
    ) : (
      <>
        <MetricChoice {...props} draft={draft} step={2} />
        <MetricDetection {...props} draft={draft} step={4} />
      </>
    );

  // Ownership, preview and alerts follow: step 4 for cron, 5 for the others.
  const after = draft.type === "cron" ? 4 : 5;

  return (
    <>
      {detection}
      <OwnershipSection {...props} step={after} />
      <IssuePreviewSection draft={draft} context={props.context} step={after + 1} />
      <AlertsSection {...props} step={after + 2} />
    </>
  );
}

function SlugField({
  draft,
  set,
  editing,
}: Pick<SectionProps, "draft" | "set" | "editing">): JSX.Element | null {
  if (draft.type !== "cron") {
    return null;
  }

  return (
    <Field
      label="Monitor Slug"
      help="SDK check-ins name the monitor by this slug. It cannot change once the monitor exists."
    >
      <input
        type="text"
        className="mono"
        placeholder="new-monitor"
        readOnly={editing}
        value={draft.config.slug}
        onChange={(event) =>
          set({ ...draft, config: { ...draft.config, slug: slugify(event.target.value) } })
        }
      />
    </Field>
  );
}

/** The project's active DSN for the instrumentation snippets, or why there is none yet. */
function useDsn(org: string, slug: string): DsnState {
  const keys = useResource(`keys:${org}:${slug}`, () => api.keys(org, slug));

  return dsnStateOf(keys);
}

function TitleBar({
  org,
  draft,
  rename,
}: {
  org: string;
  draft: NewMonitor;
  rename: (name: string) => void;
}): JSX.Element {
  return (
    <TopBar
      crumbs={[
        { label: "Monitors", to: `/${org}/monitors/` },
        { label: TYPE_LABELS[draft.type], to: `/${org}/monitors/new/?type=${draft.type}` },
      ]}
    >
      <label className="title-input">
        <input
          type="text"
          aria-label="Monitor Name"
          placeholder="New Monitor"
          value={draft.name}
          onChange={(event) => rename(event.target.value)}
        />
        <Icon name="edit" size={14} />
      </label>
    </TopBar>
  );
}

/** Until the slug is edited by hand, a new cron monitor's slug follows its name. */
function renamed(draft: NewMonitor, name: string, editing: boolean): NewMonitor {
  if (draft.type === "cron" && !editing && draft.config.slug === slugify(draft.name)) {
    return { ...draft, name, config: { ...draft.config, slug: slugify(name) } };
  }

  return { ...draft, name };
}

type Saving = { save: () => void; saving: boolean; error: string | null };

function useSave(org: string, mode: Mode, draft: NewMonitor): Saving {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (): Promise<void> => {
    setSaving(true);
    setError(null);

    try {
      const saved =
        mode.kind === "edit"
          ? await api.editMonitor(org, mode.monitor, bodyOf(draft))
          : await api.createMonitor(org, bodyOf(draft));

      toast(mode.kind === "edit" ? "Monitor saved" : "Monitor created");
      navigate(`/${org}/monitors/${saved.id}/`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The monitor could not be saved");
      setSaving(false);
    }
  };

  return { save: () => void run(), saving, error };
}

function Form({ org, context, mode, initial }: FormProps): JSX.Element {
  const [draft, setDraft] = useState<NewMonitor>(initial);
  const [guided, setGuided] = useState(false);
  const [problems, report] = useProblems();
  const editing = mode.kind === "edit";
  const project = context.projects.find(({ id }) => id === draft.projectId);

  // The project select offers only these projects, and CreateMonitor and
  // EditMonitor refuse a missing one before the form opens, so a miss here is a bug.
  if (project === undefined) {
    throw new Error(`Project ${draft.projectId} is not in the organization's projects`);
  }

  const dsn = useDsn(org, project.slug);

  const { save, saving, error } = useSave(org, mode, draft);
  const problem = Object.values(problems)[0] ?? null;

  const props = { draft, set: setDraft, context, editing, org };
  // With the cron guide open the SDK creates the monitor, so the form hides.
  const hideRest = draft.type === "cron" && guided;

  return (
    <ValidityProvider value={report}>
      <TitleBar
        org={org}
        draft={draft}
        rename={(name) => setDraft(renamed(draft, name, editing))}
      />
      <div className="content monitor-form">
        {error !== null && <div className="alert-banner danger">{error}</div>}
        {draft.type === "cron" && !editing && (
          <Instrumentation
            slug={draft.config.slug}
            config={draft.config}
            dsn={dsn}
            guided={guided}
            setGuided={setGuided}
          />
        )}
        {!hideRest && (
          <>
            <div className="sticky-preview">
              {draft.type === "metric" ? (
                <MetricPreview org={org} draft={draft} />
              ) : (
                <SchedulePreview org={org} draft={draft} />
              )}
            </div>
            <ProjectSection {...props} step={1}>
              <SlugField draft={draft} set={setDraft} editing={editing} />
            </ProjectSection>
            <Sections props={props} />
          </>
        )}
      </div>
      <FormFooter
        org={org}
        mode={mode}
        draft={draft}
        saving={saving}
        guided={hideRest}
        problem={problem}
        save={save}
      />
    </ValidityProvider>
  );
}

const TYPES = new Set<string>(["metric", "cron", "uptime"]);

function isType(value: string): value is MonitorType {
  return TYPES.has(value);
}

export function CreateMonitor({ org }: { org: string }): JSX.Element {
  const url = useUrl();
  const context = useMonitorContext(org);
  // Step 1 always names a type; arriving here without one is a stale or hand-typed URL.
  const requested = url.searchParams.get("type") ?? "";
  const projectParam = url.searchParams.get("project");

  if (!isType(requested)) {
    return <Notice loading={false} error="Choose a monitor type first." />;
  }

  if (context.data === null) {
    return <Notice loading={context.loading} error={context.error} />;
  }

  const { projects } = context.data;

  if (projects.length === 0) {
    return <Notice loading={false} error="Create a project before adding monitors." />;
  }

  // With no ?project= (the list's Create Monitor), start on the first project,
  // as Sentry's form does; the select changes it. A ?project= that names no
  // project is a stale link, and says so rather than silently using another.
  const project =
    projectParam === null ? projects[0] : projects.find(({ id }) => String(id) === projectParam);

  if (project === undefined) {
    return <Notice loading={false} error="That project does not exist." />;
  }

  return (
    <Form
      org={org}
      context={context.data}
      mode={{ kind: "create" }}
      initial={newDraft(requested, project.id)}
    />
  );
}

export function EditMonitor({ org, id }: { org: string; id: string }): JSX.Element {
  const context = useMonitorContext(org);
  const detail = useResource(`monitor:${org}:${id}`, () => api.monitor(org, id));

  if (context.data === null || detail.data === null) {
    return (
      <Notice loading={context.loading || detail.loading} error={context.error ?? detail.error} />
    );
  }

  const { monitor } = detail.data;

  // The project may have been deleted since the monitor loaded; say so, as the detail page does.
  if (!context.data.projects.some(({ id: projectId }) => projectId === monitor.projectId)) {
    return <Notice loading={false} error="This monitor's project no longer exists." />;
  }

  return (
    <Form
      key={monitor.version}
      org={org}
      context={context.data}
      mode={{ kind: "edit", monitor }}
      initial={draftOf(monitor)}
    />
  );
}
