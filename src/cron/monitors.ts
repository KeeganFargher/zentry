import type { CronMonitorStore } from "@/db/cron-monitors";
import type { MonitorStore } from "@/db/monitors";
import type { UptimeMonitorStore } from "@/db/uptime-monitors";
import { errorText, logError, logInfo } from "@/shared/log";
import type { UptimeJob } from "@/shared/monitors";
import { HOUR, MINUTE } from "@/shared/time";

import { sweepOutbox } from "./notify";
import type { NotifyCronDeps } from "./notify";
import { dispatchUptime } from "./uptime";

type MonitorTickDeps = {
  cron: CronMonitorStore;
  metric: MonitorStore;
  uptime: UptimeMonitorStore;
  queue: Queue<UptimeJob>;
  notify: NotifyCronDeps;
};

export async function evaluateMonitors(time: number, deps: MonitorTickDeps): Promise<void> {
  // Close receive-time windows two minutes behind the current tick.
  const windowEnd = Math.floor(time / MINUTE) * MINUTE - 2 * MINUTE;

  const results = await Promise.allSettled([
    deps.metric.evaluateMetrics(windowEnd),
    deps.cron.evaluate(time),
    dispatchUptime(deps.uptime, time, deps.queue),
  ]);

  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );

  await sweepOutbox(deps.notify);

  if (time % HOUR < MINUTE) {
    await deps.metric.prune(time);
  }

  if (failures.length > 0) {
    logError("monitor evaluation failed", { errors: failures.map(errorText), time });
    throw new AggregateError(failures, "one or more monitor evaluators failed");
  }

  logInfo("monitor scheduler heartbeat", { scheduledAt: time, completedAt: Date.now() });
}
