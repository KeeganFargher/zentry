import { CronDate, CronExpressionParser } from "cron-parser";

import type { CronSettings } from "@/shared/monitors";
import { DAY, MINUTE } from "@/shared/time";

export function nextCronOccurrence(config: CronSettings, since: number): number {
  if ("intervalMinutes" in config) {
    return since + config.intervalMinutes * MINUTE;
  }

  const timezone = new Intl.DateTimeFormat("en", { timeZone: config.timezone }).resolvedOptions()
    .timeZone;

  const schedule = CronExpressionParser.parse(config.expression, {
    currentDate: new Date(since),
    tz: timezone,
  });

  // cron-parser can shift a nonexistent wall time forward by an hour.
  // Validate the returned instant against the original local-time fields.
  let occurrence = schedule.next();

  while (!schedule.includesDate(occurrence) || repeatsEarlier(occurrence, timezone)) {
    occurrence = schedule.next();
  }

  return occurrence.getTime();
}

function repeatsEarlier(occurrence: CronDate, timezone: string): boolean {
  const time = occurrence.getTime();
  const currentOffset = occurrence.getUTCOffset();
  const previousOffset = new CronDate(time - DAY, timezone).getUTCOffset();
  const difference = previousOffset - currentOffset;

  // Two instants have the same wall clock when their offset change exactly
  // cancels their time difference. This also covers half-hour transitions.
  return (
    difference > 0 &&
    new CronDate(time - difference * MINUTE, timezone).getUTCOffset() === previousOffset
  );
}
