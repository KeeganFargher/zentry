// Notification crons. DESIGN.md §18.7: the weekly report queues one outbox
// row per organization each Saturday at 12:00 UTC, covering the seven UTC days
// before that day. The hourly sweep wakes the notify consumer when the outbox
// has rows left, in case a wake-up was lost after a commit, and re-requests
// the flush of any digest window well past due, whose message was lost.

import { DAY, MINUTE } from "@/shared/time";

/** A window this late has lost its flush message; a slow queue is not this late. */
const DIGEST_GRACE = 10 * MINUTE;

export type WeekRange = { start: number; end: number };

export type NotifyCronDeps = {
  queueWeeklyReports: (range: WeekRange, now: number) => Promise<number>;
  outboxSize: () => Promise<number>;
  overdueDigests: (now: number, grace: number) => Promise<number[]>;
  scheduleDigest: (projectId: number) => Promise<void>;
  notify: () => Promise<void>;
  now: () => number;
};

/** The seven whole UTC days before the day containing `now`. */
export function lastWeek(now: number): WeekRange {
  const end = Math.floor(now / DAY) * DAY;

  return { start: end - 7 * DAY, end };
}

export async function runWeeklyReports(deps: NotifyCronDeps): Promise<void> {
  const now = deps.now();

  if ((await deps.queueWeeklyReports(lastWeek(now), now)) > 0) {
    await deps.notify();
  }
}

export async function sweepOutbox(deps: NotifyCronDeps): Promise<void> {
  if ((await deps.outboxSize()) > 0) {
    await deps.notify();
  }

  for (const projectId of await deps.overdueDigests(deps.now(), DIGEST_GRACE)) {
    await deps.scheduleDigest(projectId);
  }
}
