// The caller's notification settings, and whether they follow an issue.
// DESIGN.md §18.2.

import { z } from "zod";

import {
  allowedProviders,
  allowedScopes,
  allowedValues,
  NOTIFICATION_DEFAULTS,
} from "@/core/notify-settings";
import type {
  ApiIssueSubscription,
  ApiNotificationSettings,
  NotificationProvider,
  NotificationScope,
  NotificationType,
  NotificationValue,
} from "@/shared/contract";

import type { ApiContext, Handler } from "./context";
import { badRequest, IdParam, notFound, readBody, readParams } from "./http";

const NotificationTypeParam = z.enum([
  "alerts",
  "workflow",
  "quota",
  "spikeProtection",
  "reports",
]) satisfies z.ZodType<NotificationType>;

const UpdateSettingBody = z.object({
  provider: z.enum(["email", "push"]) satisfies z.ZodType<NotificationProvider>,
  type: NotificationTypeParam,
  scope: z.enum(["user", "organization", "project"]) satisfies z.ZodType<NotificationScope>,
  scopeId: z.int().positive(),
  // Null removes the row, so the next scope out decides again.
  value: (
    z.enum(["always", "never", "subscribe_only"]) satisfies z.ZodType<NotificationValue>
  ).nullable(),
});

type UpdateSetting = z.infer<typeof UpdateSettingBody>;

const SubscriptionBody = z.object({ subscribed: z.boolean() });

async function settingsOf(context: ApiContext): Promise<ApiNotificationSettings> {
  const { notificationSettings } = context.deps;

  const [rows, pushDevices] = await Promise.all([
    notificationSettings.forUser(context.user.id, context.organizationId),
    context.deps.devices.pushCount(context.user.id),
  ]);

  return {
    defaults: NOTIFICATION_DEFAULTS,
    settings: rows.map(({ provider, type, scope, scopeId, value }) => ({
      provider,
      type,
      scope,
      scopeId,
      value,
    })),
    userId: context.user.id,
    emailEnabled: context.deps.emailEnabled,
    pushDevices,
  };
}

export const getNotificationSettings: Handler = async (context) =>
  Response.json(await settingsOf(context));

/** Why the change is refused, or null when the caller may make it. */
async function problemWith(context: ApiContext, body: UpdateSetting): Promise<string | null> {
  if (!allowedProviders(body.type).includes(body.provider)) {
    return `${body.type} cannot be sent by ${body.provider}`;
  }

  if (body.value !== null && !allowedValues(body.type).includes(body.value)) {
    return `${body.type} cannot be ${body.value}`;
  }

  if (!allowedScopes(body.type).includes(body.scope)) {
    return `${body.type} cannot be set per ${body.scope}`;
  }

  if (body.scope === "user") {
    return body.scopeId === context.user.id ? null : "scopeId must be your user id";
  }

  if (body.scope === "organization") {
    return body.scopeId === context.organizationId ? null : "scopeId must be this organization";
  }

  const projects = await context.deps.projects.list(context.organizationId);

  return projects.some((project) => project.id === body.scopeId) ? null : "no such project";
}

export const updateNotificationSetting: Handler = async (context) => {
  const body = await readBody(context.request, UpdateSettingBody);
  const problem = await problemWith(context, body);

  if (problem !== null) {
    return badRequest(problem);
  }

  const key = {
    provider: body.provider,
    userId: context.user.id,
    type: body.type,
    scope: body.scope,
    scopeId: body.scopeId,
  };

  await (body.value === null
    ? context.deps.notificationSettings.clear(key)
    : context.deps.notificationSettings.set({ ...key, value: body.value }, context.now));

  return Response.json(await settingsOf(context));
};

async function issueIdOf(context: ApiContext, args: string[]): Promise<number | null> {
  const [id] = readParams(args, z.tuple([IdParam]));
  const issue = await context.deps.issues.find(context.organizationId, id);

  return issue?.id ?? null;
}

export const getIssueSubscription: Handler = async (context, args) => {
  const issueId = await issueIdOf(context, args);

  if (issueId === null) {
    return notFound();
  }

  const subscribed = await context.deps.notificationSettings.isSubscribed(context.user.id, issueId);

  return Response.json({ subscribed } satisfies ApiIssueSubscription);
};

export const updateIssueSubscription: Handler = async (context, args) => {
  const issueId = await issueIdOf(context, args);

  if (issueId === null) {
    return notFound();
  }

  const { subscribed } = await readBody(context.request, SubscriptionBody);

  await context.deps.notificationSettings.setSubscription(
    { userId: context.user.id, active: subscribed },
    issueId,
    context.now,
  );

  return Response.json({ subscribed } satisfies ApiIssueSubscription);
};
