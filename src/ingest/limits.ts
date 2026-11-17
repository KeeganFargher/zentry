// The monthly cap per organization (DESIGN.md §6). The count is kept by the
// consumer in usage_months; ingest reads it through this cache.

import { MINUTE, monthBucket } from "@/shared/time";

const CACHE_TTL = MINUTE;

export type UsageLookup = (organizationId: number, month: number) => Promise<number>;

type Entry = { month: number; received: number; expiresAt: number };

/**
 * One count per organization per isolate, refreshed every minute, like the key
 * cache: the cap costs one D1 read per isolate per minute instead of one per
 * request. It therefore lags by up to a minute plus queue delay, so a month can
 * overshoot the cap by what arrives in that time (bounded by the burst limiter).
 * Organizations are few, so the map is not bounded.
 */
export class UsageCache {
  readonly #lookup: UsageLookup;
  readonly #entries = new Map<number, Entry>();

  constructor(lookup: UsageLookup) {
    this.#lookup = lookup;
  }

  async received(organizationId: number, now: number): Promise<number> {
    const month = monthBucket(now);
    const cached = this.#entries.get(organizationId);

    // A new month starts from its own row, not last month's cached count.
    if (cached !== undefined && cached.month === month && cached.expiresAt > now) {
      return cached.received;
    }

    const received = await this.#lookup(organizationId, month);

    this.#entries.set(organizationId, { month, received, expiresAt: now + CACHE_TTL });

    return received;
  }
}
