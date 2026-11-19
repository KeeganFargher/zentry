import { CronDate, CronExpressionParser } from "cron-parser";

import type { CronSchedule } from "@/shared/monitors";
import { DAY, HOUR, MINUTE } from "@/shared/time";

/**
 * The next expected check-in after `reference`, as Sentry's
 * `get_next_schedule` (src/sentry/monitors/schedule.py).
 *
 * The reference is floored to the minute first, as Sentry does, so a run that
 * starts a few seconds late still expects the next tick of its own schedule.
 * An interval counts from the reference, not from a fixed anchor: every
 * check-in moves the schedule, so a job that drifts never falls out of step.
 */
export function nextCheckIn(schedule: CronSchedule, timezone: string, reference: number): number {
  const from = Math.floor(reference / MINUTE) * MINUTE;

  return schedule.type === "crontab"
    ? nextCrontab(schedule.crontab, timezone, from)
    : addInterval(schedule, timezone, from);
}

function nextCrontab(expression: string, timezone: string, from: number): number {
  const schedule = CronExpressionParser.parse(expression, {
    currentDate: new Date(from),
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

type Interval = Extract<CronSchedule, { type: "interval" }>;

/**
 * Minutes and hours are elapsed time; days and longer keep the local wall
 * clock across daylight-saving changes, as dateutil's rrule does for Sentry.
 * Sentry's rrule steps hours on the wall clock too, so on a transition day an
 * hourly interval here can expect its run an hour from Sentry's. Elapsed time
 * is what a process sleeping between runs actually does.
 * A monthly or yearly step that lands on a day the month lacks (31 April,
 * 29 February) moves on to the next step that has it, again as rrule does.
 */
function addInterval({ count, unit }: Interval, timezone: string, from: number): number {
  if (unit === "minute" || unit === "hour") {
    return from + count * (unit === "minute" ? MINUTE : HOUR);
  }

  const start = wallClock(from, timezone);

  if (unit === "day" || unit === "week") {
    const days = count * (unit === "week" ? 7 : 1);
    const date = new Date(Date.UTC(start.year, start.month, start.day + days));

    return fromWallClock(
      { ...start, year: date.getUTCFullYear(), month: date.getUTCMonth(), day: date.getUTCDate() },
      timezone,
    );
  }

  const months = count * (unit === "year" ? 12 : 1);

  // A 31st recurs within 7 monthly steps and 29 February within 8 yearly
  // steps; 100 bounds the search for any count the validator accepts.
  for (let step = 1; step <= 100; step += 1) {
    const total = start.month + months * step;
    const year = start.year + Math.floor(total / 12);
    const month = total % 12;

    if (start.day <= daysInMonth(year, month)) {
      return fromWallClock({ ...start, year, month }, timezone);
    }
  }

  throw new Error(`no ${unit} step from ${from} lands on day ${start.day}`);
}

type WallClock = { year: number; month: number; day: number; hour: number; minute: number };

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function wallClock(time: number, timezone: string): WallClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  }).formatToParts(new Date(time));

  const part = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((entry) => entry.type === type);

    if (found === undefined) {
      throw new Error(`Intl omitted the ${type} of ${time} in ${timezone}`);
    }

    return Number(found.value);
  };

  return {
    year: part("year"),
    month: part("month") - 1,
    day: part("day"),
    hour: part("hour"),
    minute: part("minute"),
  };
}

/** The offset of `timezone` from UTC at `time`, in milliseconds. */
function offsetAt(time: number, timezone: string): number {
  const local = wallClock(time, timezone);

  return Date.UTC(local.year, local.month, local.day, local.hour, local.minute) - time;
}

/**
 * The instant showing `clock` in `timezone`. A repeated wall time resolves to
 * its earlier instant. A wall time skipped by a spring transition moves forward
 * by the length of the gap (02:30 becomes 03:30), as rrule's results do once
 * pytz normalizes them.
 */
function fromWallClock(clock: WallClock, timezone: string): number {
  const naive = Date.UTC(clock.year, clock.month, clock.day, clock.hour, clock.minute);
  const before = naive - offsetAt(naive - DAY, timezone);
  const after = naive - offsetAt(naive + DAY, timezone);
  const exact = [before, after].filter((time) => offsetAt(time, timezone) === naive - time);

  return exact.length > 0 ? Math.min(...exact) : Math.max(before, after);
}
