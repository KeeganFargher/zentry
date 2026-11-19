import { describe, expect, it } from "vitest";

import { nextCheckIn } from "@/core/cron-schedule";
import { CronSchedule } from "@/shared/monitors";
import { MINUTE } from "@/shared/time";

const crontab = (expression: string): CronSchedule =>
  CronSchedule.parse({ type: "crontab", crontab: expression });

const every = (count: number, unit: string): CronSchedule =>
  CronSchedule.parse({ type: "interval", count, unit });

describe("crontab schedules", () => {
  it("expects the next tick after the minute a run started in", () => {
    const hourly = crontab("0 * * * *");

    // A run that starts 30 seconds late still expects the next hour.
    expect(nextCheckIn(hourly, "UTC", Date.parse("2026-11-19T02:00:30Z"))).toBe(
      Date.parse("2026-11-19T03:00:00Z"),
    );
    expect(nextCheckIn(hourly, "UTC", Date.parse("2026-11-19T02:59:59Z"))).toBe(
      Date.parse("2026-11-19T03:00:00Z"),
    );
  });

  it("maps Sentry's crontab nicknames", () => {
    expect(crontab("@daily")).toEqual({ type: "crontab", crontab: "0 0 * * *" });
    expect(crontab("@HOURLY")).toEqual({ type: "crontab", crontab: "0 * * * *" });
    expect(() => crontab("@fortnightly")).toThrow(/five fields/u);
  });

  it("skips a nonexistent local time during spring forward", () => {
    const next = nextCheckIn(
      crontab("30 2 * * *"),
      "America/New_York",
      Date.parse("2026-03-07T08:00:00Z"),
    );

    expect(next).toBe(Date.parse("2026-03-09T06:30:00Z"));
  });

  it("uses the earlier fall-back occurrence exactly once", () => {
    const schedule = crontab("30 1 * * *");
    const next = nextCheckIn(schedule, "America/New_York", Date.parse("2026-10-31T06:00:00Z"));

    expect(next).toBe(Date.parse("2026-11-01T05:30:00Z"));
    expect(nextCheckIn(schedule, "America/New_York", next)).toBe(
      Date.parse("2026-11-02T06:30:00Z"),
    );
    expect(nextCheckIn(schedule, "America/New_York", Date.parse("2026-11-01T06:15:00Z"))).toBe(
      Date.parse("2026-11-02T06:30:00Z"),
    );
  });
});

describe("interval schedules", () => {
  it("counts from the reference, so a drifting job stays in step", () => {
    const hourly = every(1, "hour");
    let reference = Date.parse("2026-11-19T00:00:00Z");

    // Each run starts five seconds later than the last expected time; after a
    // day of drift the next expectation still follows the latest run.
    for (let run = 0; run < 24; run += 1) {
      reference = nextCheckIn(hourly, "UTC", reference) + 5000 * (run + 1);
    }

    expect(nextCheckIn(hourly, "UTC", reference) - reference).toBeLessThanOrEqual(60 * MINUTE);
    expect(nextCheckIn(hourly, "UTC", reference) - reference).toBeGreaterThan(58 * MINUTE);
  });

  it("keeps the local wall clock for daily intervals across daylight saving", () => {
    expect(nextCheckIn(every(1, "day"), "Europe/London", Date.parse("2026-03-28T09:00:00Z"))).toBe(
      Date.parse("2026-03-29T08:00:00Z"),
    );
  });

  it("moves a monthly step on to the next month that has the day", () => {
    expect(nextCheckIn(every(1, "month"), "UTC", Date.parse("2026-01-31T12:00:00Z"))).toBe(
      Date.parse("2026-03-31T12:00:00Z"),
    );
    expect(nextCheckIn(every(1, "year"), "UTC", Date.parse("2028-02-29T00:00:00Z"))).toBe(
      Date.parse("2032-02-29T00:00:00Z"),
    );
  });

  it("adds whole weeks", () => {
    expect(nextCheckIn(every(2, "week"), "UTC", Date.parse("2026-11-19T10:00:00Z"))).toBe(
      Date.parse("2026-12-03T10:00:00Z"),
    );
  });
});
