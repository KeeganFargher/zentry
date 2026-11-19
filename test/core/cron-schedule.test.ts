import { describe, expect, it } from "vitest";

import { nextCronOccurrence } from "@/core/cron-schedule";
import { CronConfig } from "@/shared/monitors";

describe("timezone-aware cron schedules", () => {
  it("skips a nonexistent local time during spring forward", () => {
    const config = CronConfig.parse({
      slug: "spring",
      environments: ["production"],
      expression: "30 2 * * *",
      timezone: "America/New_York",
    });

    const next = nextCronOccurrence(config, Date.parse("2026-03-07T08:00:00Z"));

    expect(next).toBe(Date.parse("2026-03-09T06:30:00Z"));
  });

  it("uses the earlier fall-back occurrence exactly once", () => {
    const config = CronConfig.parse({
      slug: "fall",
      environments: ["production"],
      expression: "30 1 * * *",
      timezone: "America/New_York",
    });

    const next = nextCronOccurrence(config, Date.parse("2026-10-31T06:00:00Z"));

    expect(next).toBe(Date.parse("2026-11-01T05:30:00Z"));
    expect(nextCronOccurrence(config, next)).toBe(Date.parse("2026-11-02T06:30:00Z"));
    expect(nextCronOccurrence(config, Date.parse("2026-11-01T06:15:00Z"))).toBe(
      Date.parse("2026-11-02T06:30:00Z"),
    );
  });
});
