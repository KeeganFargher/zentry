import { CronExpressionParser } from "cron-parser";

import type { CronSettings } from "@/shared/monitors";
import { MINUTE } from "@/shared/time";

export function nextCronOccurrence(config: CronSettings, since: number): number {
  if ("intervalMinutes" in config) {
    return since + config.intervalMinutes * MINUTE;
  }

  const timezone = new Intl.DateTimeFormat("en", { timeZone: config.timezone }).resolvedOptions()
    .timeZone;

  return CronExpressionParser.parse(config.expression, {
    currentDate: new Date(since),
    tz: timezone,
  })
    .next()
    .getTime();
}
