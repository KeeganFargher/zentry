// Dense time series for charts: one point per bucket, zeros included.

import type { StatPoint } from "@/shared/contract";
import { DAY, HOUR } from "@/shared/time";

export type Sample = { bucket: number; count: number };

export type Window = { now: number; step: number; points: number };

export const LAST_24_HOURS = { step: HOUR, points: 24 };
export const LAST_14_DAYS = { step: DAY, points: 14 };
export const LAST_30_DAYS = { step: DAY, points: 30 };

/** Start of the first bucket in the window. */
export function windowStart(window: Window): number {
  return Math.floor(window.now / window.step) * window.step - (window.points - 1) * window.step;
}

export function fillSeries(samples: Sample[], window: Window): StatPoint[] {
  const start = windowStart(window);
  const totals = new Map<number, number>();

  for (const sample of samples) {
    const bucket = Math.floor(sample.bucket / window.step) * window.step;

    totals.set(bucket, (totals.get(bucket) ?? 0) + sample.count);
  }

  return Array.from({ length: window.points }, (_, index): StatPoint => {
    const bucket = start + index * window.step;

    return [bucket, totals.get(bucket) ?? 0];
  });
}
