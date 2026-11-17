// The installation-wide monthly cap (DESIGN.md §6). The count is kept by the
// consumer in usage_months; ingest reads it through this cache.

import { MINUTE, monthBucket } from "@/shared/time";

const CACHE_TTL = MINUTE;

export type UsageLookup = (month: number) => Promise<number>;

/**
 * One count per isolate, refreshed every minute, like the key cache: the cap
 * costs one D1 read per isolate per minute instead of one per request. It
 * therefore lags by up to a minute plus queue delay, so a month can overshoot
 * the cap by what arrives in that time (bounded by the burst limiter).
 */
export class UsageCache {
  readonly #lookup: UsageLookup;
  #cached: { month: number; received: number; expiresAt: number } | null = null;

  constructor(lookup: UsageLookup) {
    this.#lookup = lookup;
  }

  async received(now: number): Promise<number> {
    const month = monthBucket(now);
    const cached = this.#cached;

    // A new month starts from its own row, not last month's cached count.
    if (cached !== null && cached.month === month && cached.expiresAt > now) {
      return cached.received;
    }

    const received = await this.#lookup(month);

    this.#cached = { month, received, expiresAt: now + CACHE_TTL };

    return received;
  }
}
