// Which context cards an event has and how their known values read, ported
// from ui/src/pages/event-contexts.tsx: Sentry's order, names for known
// keys, sizes in bytes, yes/no flags and start times relative to the event.

import type { Json, JsonObject, StoredEvent } from "@contract";

import { bytes, duration } from "~/lib/format";

import { describeJson, getText } from "./json";

export const TITLES = new Map([
  ["user", "User"],
  ["browser", "Browser"],
  ["runtime", "Runtime"],
  ["os", "Operating System"],
  ["client_os", "Client Operating System"],
  ["device", "Device"],
  ["app", "App"],
  ["gpu", "Graphics Processing Unit"],
  ["trace", "Trace Details"],
  ["state", "Application State"],
  ["cloud_resource", "Cloud Resource"],
  ["culture", "Culture"],
  ["memory_info", "Memory Info"],
  ["threadpool_info", "Thread Pool Info"],
  ["react_native_context", "React Native"],
  ["response", "Response"],
]);

const FIRST = ["response", "user", "browser", "runtime", "os"];

const BYTE_KEYS = new Set([
  "memory_size",
  "free_memory",
  "usable_memory",
  "storage_size",
  "free_storage",
  "external_storage_size",
  "external_free_storage",
  "app_memory",
  "total_available_memory",
  "heap_size",
  "allocated_bytes",
]);

const YES_NO = new Set([
  "charging",
  "online",
  "simulator",
  "rooted",
  "low_memory",
  "in_foreground",
]);

const TIME_KEYS = new Set(["boot_time", "app_start_time"]);

function numberOf(value: Json): number | null {
  const node = describeJson(value);

  return node.kind === "scalar" && !node.quoted && Number.isFinite(Number(node.text))
    ? Number(node.text)
    : null;
}

/** Sizes in bytes and battery percentages. */
function numeric(key: string, value: Json): string | null {
  const amount = numberOf(value);

  if (amount === null) {
    return null;
  }

  if (BYTE_KEYS.has(key)) {
    return bytes(amount);
  }

  return key === "battery_level" ? `${Math.round(amount)}%` : null;
}

/** Start times with how long before the event they were. */
function relativeTime(key: string, value: Json, eventTime: number): string | null {
  const text = TIME_KEYS.has(key) ? getText({ value }, "value") : null;
  const at = text === null ? Number.NaN : Date.parse(text);

  return Number.isNaN(at) ? null : `${text} (${duration(eventTime - at)} before this event)`;
}

/**
 * A known value as words, or null when it should show as plain JSON. The
 * web's mailto link for emails is left out: the text is selectable instead.
 */
export function formattedText(key: string, value: Json, eventTime: number): string | null {
  if (YES_NO.has(key) && (value === true || value === false)) {
    return value ? "yes" : "no";
  }

  return numeric(key, value) ?? relativeTime(key, value, eventTime);
}

export type Card = { name: string; data: JsonObject };

function hasContent(entries: [string, Json][]): boolean {
  return entries.some(([key, item]) => key !== "type" && item !== null);
}

function rank(card: Card): number {
  const position = FIRST.indexOf(card.name);

  return position === -1 ? FIRST.length : position;
}

/** The user and every context object with something besides its `type`. */
export function cardsOf(event: StoredEvent): Card[] {
  const cards: Card[] = event.user === null ? [] : [{ name: "user", data: event.user }];

  for (const [name, value] of Object.entries(event.contexts)) {
    const node = describeJson(value);

    if (node.kind === "map" && hasContent(node.entries)) {
      cards.push({ name, data: Object.fromEntries(node.entries) });
    }
  }

  return [...cards].sort((left, right) => rank(left) - rank(right));
}

/** Sorted fields, without the `type` every context carries or empty values. */
export function fieldsOf(data: JsonObject): [key: string, value: Json][] {
  return Object.entries(data)
    .flatMap(([key, value]): [string, Json][] =>
      key === "type" || value === null ? [] : [[key, value]],
    )
    .sort(([left], [right]) => left.localeCompare(right));
}
