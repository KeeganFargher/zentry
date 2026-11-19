import { z } from "zod";

import { nextCheckIn } from "@/core/cron-schedule";
import type { CronReplan } from "@/db/monitors";
import type { MonitorHistory } from "@/shared/contract";
import { CreateMonitor } from "@/shared/monitors";
import type { CronSettings, NewMonitor } from "@/shared/monitors";
import { DAY, MINUTE } from "@/shared/time";
import { approvedUptimeTarget, fixtureTarget, productionUptimeTarget } from "@/shared/uptime";

import type { ApiContext, Handler } from "./context";
import {
  badRequest,
  forbidden,
  CursorParam,
  encodeCursor,
  IntParam,
  IdParam,
  isLocal,
  notFound,
  readBody,
  readParams,
  readQuery,
} from "./http";

const ListQuery = z.object({ project: IdParam.optional() });
const MonitorId = z.tuple([z.uuid()]);
const Edit = z.strictObject({ version: z.int().positive(), monitor: CreateMonitor });

const ChangeStatus = z.strictObject({
  version: z.int().positive(),
  status: z.enum(["active", "paused", "archived"]),
});

export function validateMonitor(context: ApiContext, monitor: NewMonitor): string | undefined {
  if (monitor.type === "metric") {
    return validateMetric(monitor.config);
  }

  if (monitor.type === "uptime") {
    const target = new URL(monitor.config.url);

    const localFixture =
      isLocal(context.url) && fixtureTarget(target, context.deps.uptimeFixtureOrigin);

    if (
      target.hostname === context.deps.ingestHost ||
      applicationTarget(target, context, localFixture) ||
      !approvedUptimeTarget(target, context.organizationId, context.deps.uptimeOrigins) ||
      (!productionUptimeTarget(target) && !localFixture)
    ) {
      return "uptime URL must use an approved origin";
    }

    monitor.config.url = target.href;
  }

  return undefined;
}

function applicationTarget(target: URL, context: ApiContext, localFixture: boolean): boolean {
  return target.hostname === context.url.hostname && !localFixture;
}

function validateMetric(
  config: Extract<NewMonitor, { type: "metric" }>["config"],
): string | undefined {
  const { threshold, warningThreshold, recoveryThreshold, comparator } = config;
  const falling = comparator === "lt" || comparator === "lte";
  const warning = warningThreshold ?? threshold;

  if (warningThreshold !== undefined && (falling ? warning <= threshold : warning >= threshold)) {
    return "the medium threshold must be closer to healthy than the high threshold";
  }

  if (
    recoveryThreshold !== undefined &&
    (falling ? recoveryThreshold <= warning : recoveryThreshold >= warning)
  ) {
    return "recovery must be on the healthy side of the alert thresholds";
  }

  return undefined;
}

/**
 * The next expected check-in for a cron monitor's environments, counted from
 * now so a new or resumed schedule cannot miss slots retroactively.
 */
function cronPlan(config: CronSettings, now: number): NonNullable<CronReplan> {
  const next = nextCheckIn(config.schedule, config.timezone, now);

  return { nextCheckIn: next, nextCheckInLatest: next + config.graceMinutes * MINUTE };
}

/**
 * A re-plan only when the edit changes when check-ins are expected. Changing
 * thresholds or the runtime keeps the current expectation, so an edit cannot
 * push back a miss that is already due.
 */
/** The settings that decide when a check-in is expected. */
function timing({ schedule, timezone, graceMinutes }: CronSettings): string {
  return JSON.stringify({ schedule, timezone, graceMinutes });
}

function editReplan(current: NewMonitor, edited: NewMonitor, now: number): CronReplan {
  if (current.type !== "cron" || edited.type !== "cron") {
    return null;
  }

  return timing(current.config) === timing(edited.config) ? null : cronPlan(edited.config, now);
}

function conflict(): Response {
  return Response.json(
    { detail: "monitor changed, is archived, already exists, or exceeds the organization limit" },
    { status: 409 },
  );
}

async function validateRouting(
  context: ApiContext,
  monitor: NewMonitor,
): Promise<string | undefined> {
  const [members, rules] = await Promise.all([
    context.deps.notificationSettings.members(context.organizationId),
    context.deps.monitorRules.list(context.organizationId),
  ]);

  if (monitor.ownerId !== null && !members.some(({ userId }) => userId === monitor.ownerId)) {
    return "owner must be a member of the organization";
  }

  return monitor.alertRuleIds.every((id) => rules.some((rule) => rule.id === id))
    ? undefined
    : "all alert rules must belong to the organization";
}

export const createMonitor: Handler = async (context) => {
  if (context.role !== "owner") {
    return forbidden("only an owner can create monitors");
  }

  const body = await readBody(context.request, CreateMonitor);
  const error = validateMonitor(context, body);

  if (error !== undefined) {
    return badRequest(error);
  }

  const project = (await context.deps.projects.list(context.organizationId)).find(
    ({ id }) => id === body.projectId,
  );

  if (project === undefined) {
    return notFound();
  }

  const routing = await validateRouting(context, body);
  const requestKey = context.request.headers.get("idempotency-key");

  if (routing !== undefined || (requestKey !== null && !/^[\w-]{1,80}$/.test(requestKey))) {
    return badRequest(routing ?? "invalid idempotency key");
  }

  const monitor = await context.deps.monitors.create(context.organizationId, body, {
    userId: context.user.id,
    time: context.now,
    requestKey,
  });

  return monitor === null ? conflict() : Response.json(monitor, { status: 201 });
};

export const listMonitors: Handler = async (context) => {
  const { project } = readQuery(context.url, ListQuery);

  const scope =
    project === undefined ? ({ kind: "all" } as const) : ({ kind: "one", id: project } as const);

  return Response.json(await context.deps.monitors.list(context.organizationId, scope));
};

/** Check-ins accepted for no monitor, so a misnamed slug is visible. */
export const unrecognizedCheckIns: Handler = async (context) =>
  Response.json(await context.deps.monitors.timeline.unrecognized(context.organizationId));

export const getMonitor: Handler = async (context, args) => {
  const [id] = readParams(args, MonitorId);
  const monitor = await context.deps.monitors.find(context.organizationId, id);

  if (monitor === null) {
    return notFound();
  }

  const store = context.deps.monitors.timeline;

  const [history, audit, scopes, coverage, incidents, deliveries, checkIns] = await Promise.all([
    observationPage(context, id),
    store.audit(id),
    store.scopes(id),
    monitor.type === "uptime" ? store.uptimeCoverage(id, context.now - DAY) : null,
    store.incidents(id),
    store.deliveries(id),
    monitor.type === "cron" ? store.checkIns(id) : [],
  ]);

  return Response.json({
    monitor,
    ...history,
    audit,
    scopes,
    coverage,
    incidents,
    deliveries,
    checkIns,
  });
};

function changedCronScope(current: NewMonitor, edited: NewMonitor): boolean {
  if (current.type !== "cron" || edited.type !== "cron") {
    return false;
  }

  return current.config.slug !== edited.config.slug;
}

export const editMonitor: Handler = async (context, args) => {
  if (context.role !== "owner") {
    return forbidden("only an owner can edit monitors");
  }

  const [id] = readParams(args, MonitorId);
  const { monitor, version } = await readBody(context.request, Edit);
  const current = await context.deps.monitors.find(context.organizationId, id);

  if (current === null) {
    return notFound();
  }

  if (current.type !== monitor.type || current.projectId !== monitor.projectId) {
    return badRequest("monitor project and type are fixed");
  }

  if (changedCronScope(current, monitor)) {
    return badRequest("cron slug is fixed");
  }

  const error = validateMonitor(context, monitor);

  if (error !== undefined) {
    return badRequest(error);
  }

  const routing = await validateRouting(context, monitor);

  if (routing !== undefined) {
    return badRequest(routing);
  }

  const updated = await context.deps.monitors.edit(current, {
    monitor,
    version,
    userId: context.user.id,
    time: context.now,
    replan: editReplan(current, monitor, context.now),
  });

  return updated === null ? conflict() : Response.json(updated);
};

export const setMonitorStatus: Handler = async (context, args) => {
  if (context.role !== "owner") {
    return forbidden("only an owner can change monitor status");
  }

  const [id] = readParams(args, MonitorId);
  const status = await readBody(context.request, ChangeStatus);
  const current = await context.deps.monitors.find(context.organizationId, id);

  if (current === null) {
    return notFound();
  }

  const resumesCron = current.type === "cron" && status.status === "active";

  const updated = await context.deps.monitors.setStatus(id, {
    ...status,
    userId: context.user.id,
    time: context.now,
    replan: resumesCron ? cronPlan(current.config, context.now) : null,
  });

  return updated === null ? conflict() : Response.json(updated);
};

const HistoryQuery = z.object({
  cursor: CursorParam.pipe(z.tuple([IntParam, IntParam])).optional(),
});

const Mute = z.strictObject({ version: z.int().positive(), until: z.int().nullable() });

async function observationPage(context: ApiContext, id: string): Promise<MonitorHistory> {
  const { cursor } = readQuery(context.url, HistoryQuery);
  const [time, key] = cursor ?? [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER];

  const entries = await context.deps.monitors.timeline.history(context.organizationId, id, {
    time,
    id: key,
    size: 51,
  });

  const observations = entries.slice(0, 50);
  const last = observations.at(-1);

  return {
    observations,
    nextCursor:
      entries.length > 50 && last !== undefined ? encodeCursor([last.time, last.id]) : null,
  };
}

export const monitorHistory: Handler = async (context, args) => {
  const [id] = readParams(args, MonitorId);
  const found = await context.deps.monitors.find(context.organizationId, id);

  return found === null ? notFound() : Response.json(await observationPage(context, id));
};

export const muteMonitor: Handler = async (context, args) => {
  if (context.role !== "owner") {
    return forbidden("only an owner can mute monitors");
  }

  const [id] = readParams(args, MonitorId);
  const input = await readBody(context.request, Mute);

  if (input.until !== null && (input.until <= context.now || input.until > context.now + 7 * DAY)) {
    return badRequest("mute expiry must be within seven days");
  }

  if ((await context.deps.monitors.find(context.organizationId, id)) === null) {
    return notFound();
  }

  const updated = await context.deps.monitors.mute(id, {
    ...input,
    userId: context.user.id,
    time: context.now,
  });

  return updated === null ? conflict() : Response.json(updated);
};
