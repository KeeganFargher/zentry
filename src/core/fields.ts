// Normalization of the smaller event interfaces: message, tags, breadcrumbs
// and timestamp.

import type { Pair, StoredBreadcrumb, StoredMessage } from "@/shared/contract";
import { DAY, MINUTE, parseIsoMs } from "@/shared/time";

import { fillTemplate } from "./logentry";
import { scrubObject, scrubPairs, scrubText } from "./scrub";
import { cut, MAX_STRING, trimObject } from "./trim";
import type { WireBreadcrumb, WireEvent, WireLogEntry } from "./wire";

const MAX_BREADCRUMBS = 100;
const MAX_TAG_KEY = 32;
const MAX_TAG_VALUE = 200;
const DRIFT_THRESHOLD = 5 * MINUTE;
const BREADCRUMB_LIMITS = { depth: 3, maxKeys: 50, maxString: 1024 };

export type Clock = { receivedAt: number; sentAt: string | null };

/** Corrects client clock drift, then clamps to a sane window. */
export function resolveTimestamp(claimed: number | null, clock: Clock): number {
  const sentAt = clock.sentAt === null ? null : parseIsoMs(clock.sentAt);

  if (claimed === null) {
    return clock.receivedAt;
  }

  const drift = sentAt === null ? 0 : clock.receivedAt - sentAt;
  const corrected = Math.abs(drift) > DRIFT_THRESHOLD ? claimed + drift : claimed;
  const tooNew = corrected > clock.receivedAt + MINUTE;
  const tooOld = corrected < clock.receivedAt - 30 * DAY;

  return tooNew || tooOld ? clock.receivedAt : corrected;
}

function formattedOf(entry: WireLogEntry): string | null {
  if (entry.formatted !== null) {
    return entry.formatted;
  }

  if (entry.message === null || entry.params === null) {
    return entry.message;
  }

  return cut(fillTemplate(entry.message, entry.params), MAX_STRING);
}

function messageFrom(entry: WireLogEntry): StoredMessage | null {
  const formatted = formattedOf(entry);

  return formatted === null ? null : { message: entry.message, formatted: scrubText(formatted) };
}

/** Accepts `logentry`, a `message` object, or a plain `message` string. */
export function toStoredMessage(raw: WireEvent): StoredMessage | null {
  const entry = raw.logentry ?? raw.message;

  return entry === null ? null : messageFrom(entry);
}

export function toStoredTags(pairs: Pair[]): Pair[] {
  const kept = pairs.filter(([key, text]) => key !== "" && text !== "");

  return scrubPairs(kept.map(([key, text]) => [cut(key, MAX_TAG_KEY), cut(text, MAX_TAG_VALUE)]));
}

function toStoredBreadcrumb(raw: WireBreadcrumb): StoredBreadcrumb {
  return {
    timestamp: raw.timestamp,
    type: raw.type,
    category: raw.category,
    level: raw.level,
    message: raw.message === null ? null : scrubText(raw.message),
    data: raw.data === null ? null : scrubObject(trimObject(raw.data, BREADCRUMB_LIMITS)),
  };
}

/** Keeps the most recent. */
export function toStoredBreadcrumbs(breadcrumbs: WireBreadcrumb[]): StoredBreadcrumb[] {
  return breadcrumbs.slice(-MAX_BREADCRUMBS).map(toStoredBreadcrumb);
}
