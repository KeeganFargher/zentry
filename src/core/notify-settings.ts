// Who wants which email. DESIGN.md §18.2: a user's choice for a type is the
// most specific row stored for them, project over organization over user,
// falling back to the default below.

import type {
  NotificationProvider,
  NotificationScope,
  NotificationType,
  NotificationValue,
} from "@/shared/contract";

/** As in Sentry: everything on, workflow only for the issues you follow. */
export const NOTIFICATION_DEFAULTS = {
  alerts: "always",
  workflow: "subscribe_only",
  quota: "always",
  spikeProtection: "always",
  reports: "always",
} satisfies { [type in NotificationType]: NotificationValue };

export const NOTIFICATION_TYPES: NotificationType[] = [
  "alerts",
  "workflow",
  "quota",
  "spikeProtection",
  "reports",
];

/** Workflow alone has a middle setting. */
export function allowedValues(type: NotificationType): NotificationValue[] {
  return type === "workflow" ? ["always", "subscribe_only", "never"] : ["always", "never"];
}

/**
 * Where a type can go. The weekly report is a long read, so it is email only
 * (DESIGN.md §19); everything else can also be a push.
 */
export function allowedProviders(type: NotificationType): NotificationProvider[] {
  return type === "reports" ? ["email"] : ["email", "push"];
}

/** Which scopes a type can be set at: account-wide emails have no project. */
export function allowedScopes(type: NotificationType): NotificationScope[] {
  return type === "alerts" || type === "workflow" || type === "spikeProtection"
    ? ["user", "organization", "project"]
    : ["user", "organization"];
}

export type SettingRow = {
  userId: number;
  type: NotificationType;
  scope: NotificationScope;
  scopeId: number;
  value: NotificationValue;
};

/** The email in question: whose, which type, and where it comes from. */
export type SettingTarget = {
  userId: number;
  type: NotificationType;
  organizationId: number;
  projectId: number | null;
};

const PRECEDENCE: NotificationScope[] = ["project", "organization", "user"];

function scopeIdOf(scope: NotificationScope, target: SettingTarget): number | null {
  if (scope === "project") {
    return target.projectId;
  }

  return scope === "organization" ? target.organizationId : target.userId;
}

export function resolveSetting(rows: SettingRow[], target: SettingTarget): NotificationValue {
  for (const scope of PRECEDENCE) {
    const scopeId = scopeIdOf(scope, target);

    const row = rows.find(
      (candidate) =>
        candidate.userId === target.userId &&
        candidate.type === target.type &&
        candidate.scope === scope &&
        candidate.scopeId === scopeId,
    );

    if (row !== undefined) {
      return row.value;
    }
  }

  return NOTIFICATION_DEFAULTS[target.type];
}

/** A user's relation to one issue: an explicit unsubscribe beats `always`. */
export type Subscription = "subscribed" | "unsubscribed" | "none";

export function wantsWorkflow(value: NotificationValue, subscription: Subscription): boolean {
  if (value === "never" || subscription === "unsubscribed") {
    return false;
  }

  return value === "always" || subscription === "subscribed";
}
