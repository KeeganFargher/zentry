import { describe, expect, it } from "vitest";

import { SPIKE_HISTORY_HOURS, spikeFloor, spikeThreshold } from "@/core/spike";

const steady = (count: number): number[] =>
  Array.from({ length: SPIKE_HISTORY_HOURS }, () => count);

describe("spike floor", () => {
  it("is three months of quota spread over one month, split across up to 5 projects", () => {
    expect(spikeFloor(1_000_000, 1)).toBe(4167);
    expect(spikeFloor(1_000_000, 5)).toBe(834);
    // Projects beyond five do not lower it further.
    expect(spikeFloor(1_000_000, 50)).toBe(834);
  });

  it("never drops below 500 an hour", () => {
    expect(spikeFloor(10_000, 1)).toBe(500);
    expect(spikeFloor(10_000, 0)).toBe(500);
  });
});

describe("spike threshold", () => {
  it("is the floor for a project with no history", () => {
    expect(spikeThreshold(steady(0), 500)).toBe(500);
  });

  it("is three times steady traffic", () => {
    expect(spikeThreshold(steady(1000), 500)).toBe(3000);
  });

  it("follows the same hour on earlier days, so a daily peak is not a spike", () => {
    // 100 an hour, except 2,000 in this hour of the day on each of the last 7 days.
    const daily = steady(100).map((count, index) => (index % 24 === 0 ? 2000 : count));

    expect(spikeThreshold(daily, 0)).toBeGreaterThanOrEqual(6000);
  });

  it("caps the multiplier at 6 for very uneven traffic", () => {
    const uneven = steady(0).map((_, index) => (index === 100 ? 16_800 : 0));

    // Mean 100, extreme variation: 100 × 6.
    expect(spikeThreshold(uneven, 0)).toBe(600);
  });

  it("refuses a history of the wrong length", () => {
    expect(() => spikeThreshold([1, 2, 3], 0)).toThrow(/168 hours/);
  });
});
