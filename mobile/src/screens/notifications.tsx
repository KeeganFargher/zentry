// The user's notification settings, as on the web Notifications page: per
// provider (push or email), one choice per type for the organization, and
// per-project overrides for the types that come from a project.
// DESIGN.md §18.2 and §19.

import type {
  ApiNotificationSetting,
  ApiNotificationSettings,
  ApiProject,
  NotificationProvider,
  NotificationType,
  NotificationValue,
} from "@contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { JSX } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { Notice, Panel } from "~/components/basics";
import { Segmented } from "~/components/segmented";
import { Text } from "~/components/text";
import { toast } from "~/lib/issue-actions";
import { useOrganizations, useOrg } from "~/lib/organization";
import { projectsQuery } from "~/lib/queries";
import { useApi } from "~/lib/session";
import { SPACE } from "~/lib/theme";

type TypeInfo = {
  type: NotificationType;
  title: string;
  help: string;
  values: [NotificationValue, string][];
  perProject: boolean;
  push: boolean;
};

const ON_OFF: [NotificationValue, string][] = [
  ["always", "On"],
  ["never", "Off"],
];

// The same types, words and order as ui/src/pages/notification-settings.tsx.
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
      ["always", "All"],
      ["subscribe_only", "Followed"],
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
    help: "A summary of the last seven days, on Saturdays. Email only.",
    values: ON_OFF,
    perProject: false,
    push: false,
  },
];

const PROVIDERS: [NotificationProvider, string][] = [
  ["push", "Push"],
  ["email", "Email"],
];

/** "Same as the organization": the project row is removed. */
const INHERIT = "inherit";

type Where = Omit<ApiNotificationSetting, "value">;

function rowFor(settings: ApiNotificationSettings, where: Where): NotificationValue | null {
  const row = settings.settings.find(
    (entry) =>
      entry.provider === where.provider &&
      entry.type === where.type &&
      entry.scope === where.scope &&
      entry.scopeId === where.scopeId,
  );

  return row?.value ?? null;
}

type SectionProps = {
  provider: NotificationProvider;
  info: TypeInfo;
  settings: ApiNotificationSettings;
  organizationId: number;
  projects: ApiProject[];
  save: (where: Where, value: NotificationValue | null) => void;
};

function organizationValue(props: SectionProps): NotificationValue {
  const { provider, info, settings, organizationId } = props;
  const type = info.type;

  return (
    rowFor(settings, { provider, type, scope: "organization", scopeId: organizationId }) ??
    rowFor(settings, { provider, type, scope: "user", scopeId: settings.userId }) ??
    settings.defaults[type]
  );
}

function ProjectOverrides(props: SectionProps): JSX.Element {
  const { provider, info, settings, projects, save } = props;
  const choices: [string, string][] = [[INHERIT, "Same"], ...info.values];

  return (
    <View style={{ gap: SPACE.sm }}>
      {projects.map((project) => {
        const where: Where = { provider, type: info.type, scope: "project", scopeId: project.id };

        return (
          <View key={project.id} style={{ gap: 4 }}>
            <Text size={13}>{project.name}</Text>
            <Segmented
              label={`${info.title} for ${project.name}`}
              options={choices}
              value={rowFor(settings, where) ?? INHERIT}
              onChange={(value) =>
                save(where, info.values.find(([choice]) => choice === value)?.[0] ?? null)
              }
            />
          </View>
        );
      })}
    </View>
  );
}

function TypeSection(props: SectionProps): JSX.Element {
  const { provider, info, organizationId, projects, save } = props;
  const [open, setOpen] = useState(false);

  return (
    <Panel>
      <Text weight="medium">{info.title}</Text>
      <Text size={13} tone="muted">
        {info.help}
      </Text>
      <Segmented
        label={info.title}
        options={info.values}
        value={organizationValue(props)}
        onChange={(value) =>
          save({ provider, type: info.type, scope: "organization", scopeId: organizationId }, value)
        }
      />
      {info.perProject && projects.length > 0 && (
        <Pressable onPress={() => setOpen(!open)}>
          <Text tone="link" size={13}>
            {open ? "Hide projects" : "Set per project"}
          </Text>
        </Pressable>
      )}
      {open && <ProjectOverrides {...props} />}
    </Panel>
  );
}

function ProviderNotice({
  provider,
  settings,
}: {
  provider: NotificationProvider;
  settings: ApiNotificationSettings;
}): JSX.Element | null {
  if (provider === "email" && !settings.emailEnabled) {
    return (
      <Text tone="muted">
        This server has no email sender yet, so no email goes out. Choices made here apply from
        then.
      </Text>
    );
  }

  return provider === "push" && settings.pushDevices === 0 ? (
    <Text tone="muted">
      None of your phones can get pushes yet. Settings on this phone says why.
    </Text>
  ) : null;
}

export function NotificationsScreen(): JSX.Element {
  const api = useApi();
  const org = useOrg();
  const queries = useQueryClient();
  const { current } = useOrganizations();
  const [provider, setProvider] = useState<NotificationProvider>("push");

  const settings = useQuery({
    queryKey: ["notifications", org],
    queryFn: () => api.notifications(org),
  });

  const projects = useQuery(projectsQuery(api, org));

  const mutation = useMutation({
    mutationFn: ({ where, value }: { where: Where; value: NotificationValue | null }) =>
      api.updateNotification(org, { ...where, value }),
    onSuccess: (saved) => queries.setQueryData(["notifications", org], saved),
    onError: (cause) => toast(cause.message),
  });

  if (settings.data === undefined || projects.data === undefined || current === null) {
    const failed = settings.error ?? projects.error;

    return (
      <Notice loading={failed === null} error={failed} onRetry={() => void settings.refetch()} />
    );
  }

  return (
    <ScrollView contentContainerStyle={{ padding: SPACE.md, gap: SPACE.md }}>
      <Segmented label="Channel" options={PROVIDERS} value={provider} onChange={setProvider} />
      <ProviderNotice provider={provider} settings={settings.data} />
      {TYPES.flatMap((info) =>
        provider === "push" && !info.push
          ? []
          : [
              <TypeSection
                key={`${provider}:${info.type}`}
                provider={provider}
                info={info}
                settings={settings.data}
                organizationId={current.id}
                projects={projects.data}
                save={(where, value) => mutation.mutate({ where, value })}
              />,
            ],
      )}
    </ScrollView>
  );
}
