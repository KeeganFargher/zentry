// The create/edit form's draft: one NewMonitor, with Sentry's defaults for a
// new monitor of each type (views/detectors/components/forms/*/fields.tsx),
// and its conversion to the API's JSON body.

import type { ApiMonitor, Json, NewMonitor } from "@contract";

export type MonitorType = NewMonitor["type"];

export type CronDraft = Extract<NewMonitor, { type: "cron" }>;

export type UptimeDraft = Extract<NewMonitor, { type: "uptime" }>;

export type MetricDraft = Extract<NewMonitor, { type: "metric" }>;

type Common = Omit<NewMonitor, "type" | "config">;

function common(projectId: number): Common {
  return { projectId, name: "", description: "", ownerId: null, alertRuleIds: [], notify: true };
}

/** A new monitor's settings, as Sentry's form defaults. */
export function newDraft(type: MonitorType, projectId: number): NewMonitor {
  if (type === "cron") {
    return {
      ...common(projectId),
      type,
      config: {
        slug: "",
        schedule: { type: "crontab", crontab: "0 0 * * *" },
        timezone: "UTC",
        graceMinutes: 1,
        maxRuntimeMinutes: 30,
        failureThreshold: 1,
        recoveryThreshold: 1,
      },
    };
  }

  if (type === "uptime") {
    return {
      ...common(projectId),
      type,
      config: {
        url: "",
        method: "GET",
        intervalMinutes: 1,
        timeoutMs: 5000,
        failureThreshold: 3,
        recoveryThreshold: 1,
      },
    };
  }

  return {
    ...common(projectId),
    type,
    config: { windowSeconds: 3600, threshold: 0, comparator: "gt" },
  };
}

/**
 * Sentry's slugify, copied from src/shared/monitors.ts so the slug shown is the
 * one SDKs use. Copied because importing that module would bundle zod and
 * cron-parser into the page for one function.
 */
export function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .replaceAll(/[^ -~]/gu, "")
    .toLowerCase()
    .replaceAll(/[^\w\s-]/gu, "")
    .replaceAll(/[-\s]+/gu, "-")
    .replaceAll(/^[-_]+|[-_]+$/gu, "")
    .slice(0, 50)
    .replaceAll(/^-+|-+$/gu, "");
}

/** An existing monitor's settings, without its server-side fields. */
export function draftOf(monitor: ApiMonitor): NewMonitor {
  const { projectId, name, description, ownerId, alertRuleIds, notify } = monitor;
  const shared = { projectId, name, description, ownerId, alertRuleIds, notify };

  if (monitor.type === "cron") {
    return { ...shared, type: "cron", config: monitor.config };
  }

  return monitor.type === "uptime"
    ? { ...shared, type: "uptime", config: monitor.config }
    : { ...shared, type: "metric", config: monitor.config };
}

/** Sentry sends an unnamed monitor as "New Monitor". */
function nameOf(draft: NewMonitor): string {
  return draft.name.trim() === "" ? "New Monitor" : draft.name;
}

/** Drops the optional fields left unset, which JSON has no value for. */
function present(entries: [string, Json | undefined][]): Record<string, Json> {
  return Object.fromEntries(
    entries.filter((entry): entry is [string, Json] => entry[1] !== undefined),
  );
}

function configOf(draft: NewMonitor): Json {
  if (draft.type === "cron") {
    const { schedule, slug, ...rest } = draft.config;

    // Sentry's monitor validator takes the slug from the name when none is
    // given, so an untouched form creates "new-monitor" as Sentry's would.
    return {
      ...rest,
      slug: slug === "" ? slugify(nameOf(draft)) : slug,
      schedule: schedule.type === "crontab" ? { ...schedule } : { ...schedule },
    };
  }

  if (draft.type === "uptime") {
    const { successCodes, environment, ...rest } = draft.config;

    return {
      ...rest,
      ...present([
        ["successCodes", successCodes],
        ["environment", environment],
      ]),
    };
  }

  const { warningThreshold, recoveryThreshold, level, environment, ...rest } = draft.config;

  return {
    ...rest,
    ...present([
      ["warningThreshold", warningThreshold],
      ["recoveryThreshold", recoveryThreshold],
      ["level", level],
      ["environment", environment],
    ]),
  };
}

export function bodyOf(draft: NewMonitor): Json {
  return {
    projectId: draft.projectId,
    type: draft.type,
    name: nameOf(draft),
    description: draft.description,
    ownerId: draft.ownerId,
    alertRuleIds: [...draft.alertRuleIds],
    notify: draft.notify,
    config: configOf(draft),
  };
}
