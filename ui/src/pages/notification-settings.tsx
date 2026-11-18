// The signed-in user's notifications, as in Sentry's account settings: for
// email and for push separately, one choice per type for this organization,
// and per-project overrides for the types that come from a project.
// DESIGN.md §18.2 and §19.

import type {
  ApiNotificationSetting,
  ApiNotificationSettings,
  ApiProject,
  NotificationProvider,
  NotificationType,
  NotificationValue,
} from "@contract";
import { useState } from "react";
import type { JSX } from "react";

import { Notice } from "~/components/basics";
import { api, ApiFailure } from "~/lib/api";
import { useResource } from "~/lib/resource";
import { toast } from "~/lib/toast";

type Props = { org: string };

type TypeInfo = {
  type: NotificationType;
  title: string;
  help: string;
  values: [NotificationValue, string][];
  perProject: boolean;
  /** The weekly report is a long read, so it is email only. */
  push: boolean;
};

const ON_OFF: [NotificationValue, string][] = [
  ["always", "On"],
  ["never", "Off"],
];

const TYPES: TypeInfo[] = [
  {
    type: "alerts",
    title: "Issue alerts",
    help: "A new issue, or a resolved one that happens again. Alerts close together come as one digest.",
    values: ON_OFF,
    perProject: true,
    push: true,
  },
  {
    type: "workflow",
    title: "Workflow",
    help: "Someone resolves, archives or reopens an issue. You follow an issue once you change its status.",
    values: [
      ["always", "All issues"],
      ["subscribe_only", "Only issues I follow"],
      ["never", "Off"],
    ],
    perProject: true,
    push: true,
  },
  {
    type: "spikeProtection",
    title: "Spike protection",
    help: "A project's events are refused for the rest of the hour after an unusual burst.",
    values: ON_OFF,
    perProject: true,
    push: true,
  },
  {
    type: "quota",
    title: "Quota",
    help: "The organization has used 80% and 100% of its monthly event cap.",
    values: ON_OFF,
    perProject: false,
    push: true,
  },
  {
    type: "reports",
    title: "Weekly reports",
    help: "A summary of the last seven days, on Saturdays. Skipped for a quiet week.",
    values: ON_OFF,
    perProject: false,
    push: false,
  },
];

const INHERIT = "";

type Where = Omit<ApiNotificationSetting, "value">;

function rowFor(
  settings: ApiNotificationSettings,
  where: Where,
): ApiNotificationSetting | undefined {
  return settings.settings.find(
    (row) =>
      row.provider === where.provider &&
      row.type === where.type &&
      row.scope === where.scope &&
      row.scopeId === where.scopeId,
  );
}

/** Saves one choice; INHERIT removes the row. */
type Saver = (where: Where, value: string) => void;

type SectionProps = {
  provider: NotificationProvider;
  info: TypeInfo;
  settings: ApiNotificationSettings;
  organizationId: number;
  projects: ApiProject[];
  save: Saver;
};

/** This organization's value: its own row, else the user-wide one, else the default. */
function organizationValue(props: SectionProps): NotificationValue {
  const { provider, info, settings, organizationId } = props;
  const type = info.type;

  return (
    rowFor(settings, { provider, type, scope: "organization", scopeId: organizationId })?.value ??
    rowFor(settings, { provider, type, scope: "user", scopeId: settings.userId })?.value ??
    settings.defaults[type]
  );
}

function ProjectOverrides(props: SectionProps & { inherited: string }): JSX.Element {
  const { provider, info, settings, projects, save, inherited } = props;

  return (
    <div className="notify-projects">
      {projects.map((project) => (
        <div key={project.id} className="form-row">
          <label htmlFor={`notify-${info.type}-${project.id}`}>{project.name}</label>
          <select
            id={`notify-${info.type}-${project.id}`}
            value={
              rowFor(settings, { provider, type: info.type, scope: "project", scopeId: project.id })
                ?.value ?? INHERIT
            }
            onChange={(event) =>
              save(
                { provider, type: info.type, scope: "project", scopeId: project.id },
                event.target.value,
              )
            }
          >
            <option value={INHERIT}>Same as above ({inherited})</option>
            {info.values.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
      ))}
    </div>
  );
}

function TypeSection(props: SectionProps): JSX.Element {
  const { provider, info, organizationId, projects, save } = props;
  const current = organizationValue(props);
  const inherited = info.values.find(([value]) => value === current)?.[1] ?? current;

  return (
    <section className="panel padded">
      <h2>{info.title}</h2>
      <p className="muted">{info.help}</p>
      <div className="form-row">
        <label htmlFor={`notify-${info.type}`}>For this organization</label>
        <select
          id={`notify-${info.type}`}
          value={current}
          onChange={(event) =>
            save(
              { provider, type: info.type, scope: "organization", scopeId: organizationId },
              event.target.value,
            )
          }
        >
          {info.values.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
      {info.perProject && projects.length > 0 && (
        <ProjectOverrides {...props} inherited={inherited} />
      )}
    </section>
  );
}

const PROVIDERS: [NotificationProvider, string][] = [
  ["email", "Email"],
  ["push", "Push"],
];

type NoticeProps = {
  provider: NotificationProvider;
  settings: ApiNotificationSettings;
  org: string;
};

/** Says when the chosen provider would deliver nothing yet. */
function ProviderNotice({ provider, settings, org }: NoticeProps): JSX.Element | null {
  if (provider === "email" && !settings.emailEnabled) {
    return (
      <div className="notice">
        This deployment has no sender address, so no email is sent yet. Set EMAIL_FROM to turn email
        on (see README.md, Email). Choices made here apply from then.
      </div>
    );
  }

  if (provider === "push" && settings.pushDevices === 0) {
    return (
      <div className="notice">
        No phone of yours can get pushes yet. Sign in to the Android app from{" "}
        <a href={`/${org}/settings/mobile/`}>Mobile app</a> and allow notifications there. Choices
        made here apply from then.
      </div>
    );
  }

  return null;
}

type TabsProps = {
  provider: NotificationProvider;
  onChange: (provider: NotificationProvider) => void;
};

function ProviderTabs({ provider, onChange }: TabsProps): JSX.Element {
  return (
    <div className="segmented" role="tablist" aria-label="Where notifications go">
      {PROVIDERS.map(([value, label]) => (
        <button
          key={value}
          type="button"
          role="tab"
          aria-selected={provider === value}
          className={provider === value ? "active" : ""}
          onClick={() => onChange(value)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function NotificationSettings({ org }: Props): JSX.Element {
  const [provider, setProvider] = useState<NotificationProvider>("email");
  const settings = useResource(`notifications:${org}`, () => api.notifications(org));
  const projects = useResource(`projects:${org}`, () => api.projects(org));
  const me = useResource("me", api.me);
  const organizationId = me.data?.organizations.find((entry) => entry.slug === org)?.id;

  const current = settings.data;
  const list = projects.data;

  if (current === null || list === null || organizationId === undefined) {
    return (
      <Notice
        loading={settings.loading || projects.loading}
        error={settings.error ?? projects.error}
      />
    );
  }

  const store = async (where: Where, value: string): Promise<void> => {
    try {
      await api.updateNotification(org, { ...where, value: value === INHERIT ? null : value });
      toast("Notification settings saved");
      settings.reload();
    } catch (cause) {
      toast(cause instanceof ApiFailure ? cause.message : "Could not save the setting");
    }
  };

  const save: Saver = (where, value) => void store(where, value);

  return (
    <>
      <header className="topbar">
        <h1>Notifications</h1>
        <span className="spacer" />
        <ProviderTabs provider={provider} onChange={setProvider} />
      </header>
      <div className="content narrow">
        <ProviderNotice provider={provider} settings={current} org={org} />
        {TYPES.flatMap((info) =>
          provider === "push" && !info.push
            ? []
            : [
                <TypeSection
                  key={`${provider}:${info.type}`}
                  provider={provider}
                  info={info}
                  settings={current}
                  organizationId={organizationId}
                  projects={list}
                  save={save}
                />,
              ],
        )}
      </div>
    </>
  );
}
