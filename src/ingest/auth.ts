// DSN authentication. The public key comes from the first of: the
// X-Sentry-Auth header, the `sentry_key` query parameter, the envelope's dsn.

import type { KeyInfo } from "@/db/keys";
import { isPublicKey } from "@/shared/ids";
import { MINUTE } from "@/shared/time";

const CACHE_TTL = MINUTE;
const CACHE_MAX_ENTRIES = 5000;

export type KeyLookup = (publicKey: string) => Promise<KeyInfo | null>;

type CacheEntry = { info: KeyInfo | null; expiresAt: number };

function headerKey(request: Request): string | null {
  const header = request.headers.get("x-sentry-auth") ?? "";

  return /sentry_key=([0-9a-fA-F]+)/.exec(header)?.[1] ?? null;
}

export function requestPublicKey(request: Request, envelopeKey: string | null): string | null {
  const queryKey = new URL(request.url).searchParams.get("sentry_key");
  const key = (headerKey(request) ?? queryKey ?? envelopeKey ?? "").toLowerCase();

  return isPublicKey(key) ? key : null;
}

/**
 * Caches lookups, misses included, for a minute per isolate. A revoked key or
 * a new rate limit therefore takes up to a minute to be seen.
 */
export class KeyCache {
  readonly #entries = new Map<string, CacheEntry>();
  readonly #lookup: KeyLookup;

  constructor(lookup: KeyLookup) {
    this.#lookup = lookup;
  }

  async find(publicKey: string, now: number): Promise<KeyInfo | null> {
    const cached = this.#entries.get(publicKey);

    if (cached !== undefined && cached.expiresAt > now) {
      return cached.info;
    }

    const info = await this.#lookup(publicKey);

    if (this.#entries.size >= CACHE_MAX_ENTRIES) {
      this.#entries.clear();
    }

    this.#entries.set(publicKey, { info, expiresAt: now + CACHE_TTL });

    return info;
  }
}
