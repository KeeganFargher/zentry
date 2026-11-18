// Daily retention. DESIGN.md §9. Events expire; issues stay, as in Sentry, so a
// recurrence of an old issue is a regression, not a new issue. Each step repeats in chunks until it has
// nothing left or the time budget is spent; the next run picks up the rest.
// R2 objects are removed by the bucket's lifecycle rules, not here.

import { logInfo } from "@/shared/log";
import { DAY, SECOND } from "@/shared/time";

export type RetentionDeps = {
  deleteEventsBefore: (cutoff: number) => Promise<number>;
  deleteGroupStatsBefore: (cutoff: number) => Promise<number>;
  deleteProjectStatsBefore: (cutoff: number) => Promise<number>;
  pruneTags: (keep: number) => Promise<number>;
  clearExpiredLimits: (now: number) => Promise<number>;
  deleteEmailSendsBefore: (cutoff: number) => Promise<number>;
  deletePushSendsBefore: (cutoff: number) => Promise<number>;
  retentionDays: number;
  now: () => number;
};

const TIME_BUDGET = 20 * SECOND;
const GROUP_STATS_DAYS = 30;
const PROJECT_STATS_DAYS = 90;
const MAX_TAG_VALUES = 200;
const EMAIL_SENDS_DAYS = 30;

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

  const run = async (step: () => Promise<number>): Promise<number> =>
    drain(step, deadline, deps.now);

  // Every step shares one budget, in the order of DESIGN.md §9. A step the
  // budget does not reach waits for tomorrow's run rather than overrunning.
  const events = await run(() => deps.deleteEventsBefore(started - deps.retentionDays * DAY));
  const groupStats = await run(() => deps.deleteGroupStatsBefore(started - GROUP_STATS_DAYS * DAY));

  const projectStats = await run(() =>
    deps.deleteProjectStatsBefore(started - PROJECT_STATS_DAYS * DAY),
  );

  const tags = await run(() => deps.pruneTags(MAX_TAG_VALUES));
  const limits = await run(() => deps.clearExpiredLimits(started));
  const emailSends = await run(() => deps.deleteEmailSendsBefore(started - EMAIL_SENDS_DAYS * DAY));
  const pushSends = await run(() => deps.deletePushSendsBefore(started - EMAIL_SENDS_DAYS * DAY));

  logInfo("retention finished", {
    events,
    groupStats,
    projectStats,
    tags,
    limits,
    emailSends,
    pushSends,
    ms: deps.now() - started,
  });
}
