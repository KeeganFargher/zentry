import { catchupWrite, missedSlots, timedOut, toWrite } from "@/core/cron-checkins";
import { withCronIssues } from "@/core/monitor-issues";
import type { CronStore } from "@/db/cron-store";

// Deadlines each minute tick finalizes per kind, and missed slots per
// environment per tick, so one tick stays well inside the scheduled handler's
// time. A backlog drains over the following ticks.
const TICK_BATCH = 100;
const MISSED_PER_ENVIRONMENT = 10;

/** Times out open runs past their runtime, then records missed check-ins. */
export async function evaluateCronDeadlines(store: CronStore, now: number): Promise<void> {
  for (const { id, monitor } of await store.dueTimeouts(now, TICK_BATCH)) {
    const stored = await store.checkInById(id);

    await store.update(
      { monitorId: monitor.id, environment: stored.environment, now },
      async (read) => {
        // Read again inside the retry: a result that arrived since the scan wins.
        const row = await store.checkInById(id);

        if (row.status !== "in_progress" || row.timeoutAt === null || row.timeoutAt > now) {
          return null;
        }

        const write = toWrite({ change: timedOut(monitor.config, read.state, row), stored: row });

        return write === null ? null : withCronIssues(write, read.issue, now);
      },
    );
  }

  for (const { environment, monitor } of await store.dueEnvironments(now, TICK_BATCH)) {
    await store.update({ monitorId: monitor.id, environment, now }, async (read) => {
      const missed = missedSlots(monitor.config, read.state, {
        now,
        limit: MISSED_PER_ENVIRONMENT,
        newId: () => crypto.randomUUID().replaceAll("-", ""),
      });

      const write = catchupWrite(missed);

      return write === null ? null : withCronIssues(write, read.issue, now);
    });
  }
}
