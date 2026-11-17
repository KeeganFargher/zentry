// Hourly spike-protection thresholds. DESIGN.md §6. Recomputing every hour, as
// Sentry does, lets the threshold follow a project's traffic as it grows, and
// a spike that lasts becomes, slowly, the new baseline.

import { SPIKE_HISTORY_HOURS, spikeFloor, spikeThreshold } from "@/core/spike";
import type { SpikeInput, SpikeLimit } from "@/db/spike";
import { logInfo } from "@/shared/log";
import { HOUR, hourBucket } from "@/shared/time";

export type SpikeDeps = {
  read: (since: number, before: number) => Promise<SpikeInput>;
  write: (limits: SpikeLimit[]) => Promise<void>;
  maxEventsPerMonth: number;
  now: () => number;
};

/** The last 168 complete hours of one project, oldest first, zeros filled. */
function historyOf(input: SpikeInput, projectId: number, since: number): number[] {
  const hours = Array.from({ length: SPIKE_HISTORY_HOURS }, () => 0);

  for (const hour of input.hours) {
    if (hour.projectId === projectId) {
      hours[(hour.bucket - since) / HOUR] = hour.received;
    }
  }

  return hours;
}

export async function runSpikeProtection(deps: SpikeDeps): Promise<void> {
  const current = hourBucket(deps.now());
  const since = current - SPIKE_HISTORY_HOURS * HOUR;
  const input = await deps.read(since, current);
  const floor = spikeFloor(deps.maxEventsPerMonth, input.projectCount);

  const limits = input.protectedIds.map((p) => ({
    p,
    limit: spikeThreshold(historyOf(input, p, since), floor),
  }));

  await deps.write(limits);

  logInfo("spike thresholds updated", { projects: limits.length, floor });
}
