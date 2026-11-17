// Daily retention. DESIGN.md §9. Events expire; issues stay, as in Sentry, so a
// recurrence of an old issue is a regression, not a new issue. Each step repeats in chunks until it has
// nothing left or the time budget is spent; the next run picks up the rest.
// R2 objects are removed by the bucket's lifecycle rules, not here.

import type { StatsCutoffs } from "@/db/retention";
import { logInfo } from "@/shared/log";
import { DAY, SECOND } from "@/shared/time";

export type RetentionDeps = {
  deleteEventsBefore: (cutoff: number) => Promise<number>;
  deleteStatsBefore: (cutoffs: StatsCutoffs) => Promise<number>;
  pruneTags: (keep: number) => Promise<number>;
  clearExpiredLimits: (now: number) => Promise<number>;
  retentionDays: number;
  now: () => number;
};

const TIME_BUDGET = 20 * SECOND;
const GROUP_STATS_DAYS = 30;
const PROJECT_STATS_DAYS = 90;
const MAX_TAG_VALUES = 200;

/** Runs `step` until it removes nothing or the deadline passes. */
async function drain(
  step: () => Promise<number>,
  deadline: number,
  now: () => number,
): Promise<number> {
  let total = 0;

  while (now() < deadline) {
    const removed = await step();

    total += removed;

    if (removed === 0) {
      break;
    }
  }

  return total;
}

export async function runRetention(deps: RetentionDeps): Promise<void> {
  const started = deps.now();
  const deadline = started + TIME_BUDGET;
  const cutoff = started - deps.retentionDays * DAY;
  const events = await drain(() => deps.deleteEventsBefore(cutoff), deadline, deps.now);
  const tags = await drain(() => deps.pruneTags(MAX_TAG_VALUES), deadline, deps.now);

  const stats = await deps.deleteStatsBefore({
    groupStatsBefore: started - GROUP_STATS_DAYS * DAY,
    projectStatsBefore: started - PROJECT_STATS_DAYS * DAY,
  });

  await deps.clearExpiredLimits(started);

  logInfo("retention finished", { events, tags, stats, ms: deps.now() - started });
}
