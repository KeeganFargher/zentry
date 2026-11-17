// Normalization of the smaller event interfaces: message, tags, breadcrumbs,
// timestamp and level.

import type {
  Json,
  JsonObject,
  Level,
  Pair,
  StoredBreadcrumb,
  StoredMessage,
} from "@/shared/contract";
import {
  asArray,
  asNumber,
  asObject,
  asString,
  asText,
  getArray,
  getNonEmpty,
  getObject,
  objectsIn,
} from "@/shared/json";
import { DAY, MINUTE, parseIsoMs, SECOND } from "@/shared/time";

import { fillTemplate } from "./logentry";
import { scrubObject, scrubPairs, scrubText } from "./scrub";
import { cut, cutOrNull, MAX_STRING, trimObject } from "./trim";

const LEVEL_NAMES = new Map<string, Level>([
  ["fatal", "fatal"],
  ["critical", "fatal"],
  ["error", "error"],
  ["warning", "warning"],
  ["warn", "warning"],
  ["info", "info"],
  ["log", "info"],
  ["debug", "debug"],
]);

// Python's logging numbers, which some SDKs send as they are.
const LEVEL_NUMBERS: [from: number, level: Level][] = [
  [50, "fatal"],
  [40, "error"],
  [30, "warning"],
  [20, "info"],
  [0, "debug"],
];

const MAX_BREADCRUMBS = 100;
const MAX_TAG_KEY = 32;
const MAX_TAG_VALUE = 200;
const DRIFT_THRESHOLD = 5 * MINUTE;
const BREADCRUMB_LIMITS = { depth: 3, maxKeys: 50, maxString: 1024 };

function levelNumber(value: Json | undefined): number | null {
  const text = asString(value)?.trim() ?? "";
  const number = asNumber(value) ?? (text === "" ? null : Number(text));

  return number !== null && Number.isFinite(number) ? number : null;
}

/** A level name (any case, with Sentry's aliases) or a Python logging number. */
export function parseLevel(value: Json | undefined): Level {
  const number = levelNumber(value);

  if (number !== null) {
    return LEVEL_NUMBERS.find(([from]) => number >= from)?.[1] ?? "error";
  }

  return LEVEL_NAMES.get(asString(value)?.trim().toLowerCase() ?? "") ?? "error";
}

/** Epoch seconds (number) or ISO 8601 (string), as milliseconds. */
export function parseTimestamp(value: Json | undefined): number | null {
  const seconds = asNumber(value);
  const text = asString(value);

  if (seconds !== null) {
    return Math.round(seconds * SECOND);
  }

  return text === null ? null : parseIsoMs(text);
}

export type Clock = { receivedAt: number; sentAt: string | null };

/** Corrects client clock drift, then clamps to a sane window. */
export function resolveTimestamp(value: Json | undefined, clock: Clock): number {
  const claimed = parseTimestamp(value);
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

function messageFrom(source: JsonObject): StoredMessage | null {
  const message = getNonEmpty(source, "message");
  const formatted = getNonEmpty(source, "formatted") ?? fillTemplate(message, source["params"]);

  if (formatted === null) {
    return null;
  }

  return {
    message: cutOrNull(message, MAX_STRING),
    formatted: scrubText(cut(formatted, MAX_STRING)),
  };
}

/** Accepts `logentry`, a `message` object, or a plain `message` string. */
export function parseMessage(raw: JsonObject): StoredMessage | null {
  const structured = getObject(raw, "logentry") ?? getObject(raw, "message");
  const plain = getNonEmpty(raw, "message");

  if (structured !== null) {
    return messageFrom(structured);
  }

  return plain === null ? null : { message: null, formatted: scrubText(cut(plain, MAX_STRING)) };
}

function pairFrom(entry: Json): Pair | null {
  const [key, value] = asArray(entry) ?? [];
  const name = asText(key);
  const text = asText(value);

  return name === null || text === null ? null : [name, text];
}

/** Accepts an object or a list of `[key, value]` pairs. */
export function parsePairs(value: Json | undefined): Pair[] {
  const dictionary = asObject(value);
  const entries = dictionary === null ? (asArray(value) ?? []) : Object.entries(dictionary);
  const pairs: Pair[] = [];

  for (const entry of entries) {
    const pair = pairFrom(entry);

    if (pair !== null) {
      pairs.push(pair);
    }
  }

  return pairs;
}

export function parseTags(value: Json | undefined): Pair[] {
  const pairs = parsePairs(value).filter(([key, text]) => key !== "" && text !== "");

  return scrubPairs(pairs.map(([key, text]) => [cut(key, MAX_TAG_KEY), cut(text, MAX_TAG_VALUE)]));
}

function parseBreadcrumb(raw: JsonObject): StoredBreadcrumb {
  const data = getObject(raw, "data");
  const message = getNonEmpty(raw, "message");

  return {
    timestamp: parseTimestamp(raw["timestamp"]),
    type: cutOrNull(getNonEmpty(raw, "type"), 100),
    category: cutOrNull(getNonEmpty(raw, "category"), 200),
    level: cutOrNull(getNonEmpty(raw, "level"), 20),
    message: message === null ? null : scrubText(cut(message, MAX_STRING)),
    data: data === null ? null : scrubObject(trimObject(data, BREADCRUMB_LIMITS)),
  };
}

/** Accepts `{values: [...]}` or a bare list. Keeps the most recent. */
export function parseBreadcrumbs(value: Json | undefined): StoredBreadcrumb[] {
  const wrapped = asObject(value);
  const list = wrapped === null ? asArray(value) : getArray(wrapped, "values");

  return objectsIn(list).slice(-MAX_BREADCRUMBS).map(parseBreadcrumb);
}
