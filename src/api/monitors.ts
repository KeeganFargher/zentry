import { z } from "zod";

import { nextCronOccurrence } from "@/core/cron-schedule";
import type { MonitorPreview } from "@/shared/contract";
import { CreateMonitor } from "@/shared/monitors";
import type { NewMonitor } from "@/shared/monitors";
import { MINUTE } from "@/shared/time";
import { approvedUptimeTarget, productionUptimeTarget } from "@/shared/uptime";

import type { ApiContext, Handler } from "./context";
import {
  badRequest,
  forbidden,
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

function validateMonitor(context: ApiContext, monitor: NewMonitor): string | undefined {
  if (
    monitor.type === "metric" &&
    monitor.config.recoveryThreshold !== undefined &&
    monitor.config.recoveryThreshold >= monitor.config.threshold
  ) {
    return "metric recovery threshold must be lower than the breach threshold";
  }

  if (monitor.type === "uptime") {
    const target = new URL(monitor.config.url);
    const localFixture = isLocal(context.url) && target.origin === "http://localhost:5199";

    if (
      !approvedUptimeTarget(target, context.deps.uptimeOrigins) ||
      (!productionUptimeTarget(target) && !localFixture)
    ) {
      return "uptime URL must use an approved origin";
    }

    monitor.config.url = target.href;
  }

  return monitor.type === "cron" ? validateCron(monitor, context.now) : undefined;
}

function validateCron(
  monitor: Extract<NewMonitor, { type: "cron" }>,
  now: number,
): string | undefined {
  try {
    nextCronOccurrence(monitor.config, now);
  } catch {
    return "invalid crontab or timezone";
  }

  return undefined;
}

function conflict(): Response {
  return Response.json(
    { detail: "monitor changed, is archived, already exists, or exceeds the organization limit" },
    { status: 409 },
  );
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

  const monitor = await context.deps.monitors.create(context.organizationId, body, context.now);

  return monitor === null ? conflict() : Response.json(monitor, { status: 201 });
};

export const listMonitors: Handler = async (context) => {
  const { project } = readQuery(context.url, ListQuery);

  const scope =
    project === undefined ? ({ kind: "all" } as const) : ({ kind: "one", id: project } as const);

  return Response.json(await context.deps.monitors.list(context.organizationId, scope));
};

export const getMonitor: Handler = async (context, args) => {
  const [id] = readParams(args, MonitorId);
  const monitor = await context.deps.monitors.find(context.organizationId, id);

  if (monitor === null) {
    return notFound();
  }

  return Response.json({
    monitor,
    observations: await context.deps.monitors.history(context.organizationId, id),
  });
};

function changedCronScope(current: NewMonitor, edited: NewMonitor): boolean {
  if (current.type !== "cron" || edited.type !== "cron") {
    return false;
  }

  return (
    current.config.slug !== edited.config.slug ||
    current.config.environment !== edited.config.environment
  );
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
    return badRequest("cron slug and environment are fixed");
  }

  const error = validateMonitor(context, monitor);

  if (error !== undefined) {
    return badRequest(error);
  }

  const updated = await context.deps.monitors.edit(current, { monitor, version });

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

  const updated = await context.deps.monitors.setStatus(id, status);

  return updated === null ? conflict() : Response.json(updated);
};

export const previewMonitor: Handler = async (context) => {
  if (context.role !== "owner") {
    return forbidden("only an owner can preview monitors");
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

  if (!(await context.deps.allowMonitorPreview(String(context.organizationId)))) {
    return Response.json({ detail: "too many monitor previews" }, { status: 429 });
  }

  return Response.json(await preview(context, body));
};

async function preview(context: ApiContext, body: NewMonitor): Promise<MonitorPreview> {
  if (body.type === "uptime") {
    return { type: "uptime", ...(await context.deps.previewUptime(body.config)) };
  }

  if (body.type === "metric") {
    const windowEnd = Math.floor(context.now / MINUTE) * MINUTE - 2 * MINUTE;
    const count = await context.deps.monitors.count(body, windowEnd);

    return { type: "metric", count, windowEnd };
  }

  const occurrences: number[] = [];
  let time = context.now;

  for (let index = 0; index < 5; index += 1) {
    time = nextCronOccurrence(body.config, time);
    occurrences.push(time);
  }

  return { type: "cron", occurrences };
}
