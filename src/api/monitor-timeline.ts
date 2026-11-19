import { z } from "zod";

import { DAY, MINUTE } from "@/shared/time";

import type { Handler } from "./context";
import { badRequest, IntParam, notFound, readParams, readQuery } from "./http";

const MonitorId = z.tuple([z.uuid()]);

const TimelineQuery = z.object({
  since: IntParam,
  until: IntParam,
  buckets: IntParam.pipe(z.int().min(10).max(500)),
});

// Check-ins are kept 30 days (src/db/monitors.ts prune), so a longer range
// would draw an empty start rather than real history.
const MAX_RANGE = 30 * DAY;

/** The monitor's ticks, bucketed so the page draws one per column of its timeline. */
export const monitorTimeline: Handler = async (context, args) => {
  const [id] = readParams(args, MonitorId);
  const { since, until, buckets } = readQuery(context.url, TimelineQuery);

  if (until <= since || until - since > MAX_RANGE) {
    return badRequest("the range must be positive and at most 30 days");
  }

  const monitor = await context.deps.monitors.find(context.organizationId, id);

  if (monitor === null) {
    return notFound();
  }

  // Whole minutes, so buckets line up with the minute-aligned check-in schedule.
  const bucketMs = Math.max(MINUTE, Math.ceil((until - since) / buckets / MINUTE) * MINUTE);

  return Response.json(
    await context.deps.monitors.timeline.timeline(monitor, { since, until, bucketMs }),
  );
};
