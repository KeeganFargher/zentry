import { z } from "zod";

import { nextCheckIn } from "@/core/cron-schedule";
import type { MonitorPreview, MonitorPreviewJob } from "@/shared/contract";
import { jsonText } from "@/shared/json";
import { CreateMonitor } from "@/shared/monitors";
import type { NewMonitor } from "@/shared/monitors";
import { MINUTE } from "@/shared/time";
import { ProbeResponse } from "@/shared/uptime";

import type { ApiContext, Handler } from "./context";
import { badRequest, forbidden, notFound, readBody, readParams } from "./http";
import { validateMonitor } from "./monitors";

const PreviewId = z.tuple([z.uuid()]);
const Result = jsonText(ProbeResponse);

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

  if (body.type === "uptime") {
    const id = crypto.randomUUID();
    const expiresAt = context.now + 2 * MINUTE;
    await context.deps.monitorPreviews.create(
      id,
      { config: body.config, organizationId: context.organizationId },
      { expiresAt, now: context.now, actorId: context.user.id },
    );
    await context.deps.enqueueMonitorPreview(id);
    const job: MonitorPreviewJob = { type: "uptime_job", id, expiresAt, status: "pending" };

    return Response.json(job, { status: 202 });
  }

  return Response.json(await readSignalPreview(context, body));
};

export const getMonitorPreview: Handler = async (context, args) => {
  if (context.role !== "owner") {
    return forbidden("only an owner can view monitor previews");
  }

  const [id] = readParams(args, PreviewId);
  const preview = await context.deps.monitorPreviews.get(context.organizationId, id);

  if (preview === null) {
    return notFound();
  }

  const job: MonitorPreviewJob = {
    type: "uptime_job",
    id,
    expiresAt: preview.expiresAt,
    status: "pending",
  };

  if (preview.expiresAt <= context.now) {
    job.status = "expired";
  } else if (preview.result !== null) {
    job.status = "complete";
    job.result = { type: "uptime", ...Result.parse(preview.result) };
  }

  return Response.json(job);
};

async function readSignalPreview(
  context: ApiContext,
  body: Exclude<NewMonitor, { type: "uptime" }>,
): Promise<MonitorPreview> {
  if (body.type === "metric") {
    const windowEnd = Math.floor(context.now / MINUTE) * MINUTE - 2 * MINUTE;
    const points = await context.deps.monitors.metricPreview(body, windowEnd);

    return {
      type: "metric",
      count: points.at(-1)?.count ?? 0,
      windowEnd,
      points,
      threshold: body.config.threshold,
      warningThreshold: body.config.warningThreshold,
    };
  }

  const occurrences: number[] = [];
  let time = context.now;

  // Twenty, as the form's sample timeline draws twenty check-ins.
  for (let index = 0; index < 20; index += 1) {
    time = nextCheckIn(body.config.schedule, body.config.timezone, time);
    occurrences.push(time);
  }

  return { type: "cron", occurrences };
}
