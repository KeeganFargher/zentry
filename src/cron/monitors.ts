import { CronStore } from "@/db/cron-store";
import { MetricEvaluationStore } from "@/db/metric-evaluation";
import { MonitorStore } from "@/db/monitors";
import { UptimeMonitorStore } from "@/db/uptime-monitors";
import { errorText, logError, logInfo } from "@/shared/log";
import type { UptimeJob } from "@/shared/monitors";
import { MINUTE } from "@/shared/time";

import { evaluateCronDeadlines } from "./cron-deadlines";
import { evaluateMetrics } from "./metric-evaluation";
import { sweepOutbox } from "./notify";
import type { NotifyCronDeps } from "./notify";
import { dispatchUptime } from "./uptime";

type MonitorTickDeps = {
  db: D1Database;
  queue: Queue<UptimeJob>;
  notify: NotifyCronDeps;
};

/**
 * The minute tick: metric windows, cron deadlines and uptime dispatch run
 * independently, so one failing does not stop the others, then the outbox is
 * swept and expired monitor data pruned.
 */
export async function evaluateMonitors(time: number, deps: MonitorTickDeps): Promise<void> {
  const metric = new MonitorStore(deps.db);
  // Close receive-time windows two minutes behind the current tick.
  const windowEnd = Math.floor(time / MINUTE) * MINUTE - 2 * MINUTE;

  const results = await Promise.allSettled([
    evaluateMetrics(new MetricEvaluationStore(deps.db), windowEnd),
    evaluateCronDeadlines(new CronStore(deps.db), time),
    dispatchUptime(new UptimeMonitorStore(deps.db), time, deps.queue),
  ]);

  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );

  await sweepOutbox(deps.notify);
  await metric.prune(time);

  if (failures.length > 0) {
    logError("monitor evaluation failed", { errors: failures.map(errorText), time });
    throw new AggregateError(failures, "one or more monitor evaluators failed");
  }

  logInfo("monitor scheduler heartbeat", { scheduledAt: time, completedAt: Date.now() });
}
