// How a breadcrumb is classified, titled and timed, ported from
// ui/src/pages/breadcrumbs.tsx. The web's icons are left out; the colour
// that goes with each type stays.

import type { Json, JsonObject, StoredBreadcrumb, StoredEvent } from "@contract";

import { jsonText } from "./json";

export type Crumb = StoredBreadcrumb & { virtual: boolean };

/** The palette colour a crumb type is drawn in (the web's red, green… classes). */
export type CrumbTone = "error" | "warning" | "ok" | "info" | "literal" | "debug";

/** Sentry upgrades untyped crumbs by their category. */
const CATEGORY_TYPES = new Map([
  ["console", "debug"],
  ["logcat", "debug"],
  ["timber", "debug"],
  ["session", "navigation"],
  ["graphql", "query"],
  ["query", "query"],
  ["sql.query", "query"],
  ["exception", "error"],
]);

export function typeOf(crumb: Crumb): string {
  const type = crumb.type ?? "default";

  if (type !== "default") {
    return type;
  }

  const category = crumb.category?.toLowerCase() ?? "";

  return CATEGORY_TYPES.get(category) ?? (category.startsWith("ui.") ? "ui" : "default");
}

const TONES: [types: string[], tone: CrumbTone][] = [
  [["error"], "error"],
  [["warning"], "warning"],
  [["navigation", "http", "query"], "ok"],
  [["ui", "user", "info"], "info"],
  [["system", "device", "network"], "literal"],
];

export function toneOf(type: string): CrumbTone {
  return TONES.find(([types]) => types.includes(type))?.[1] ?? "debug";
}

/** "HTTP", "Navigation"; untyped crumbs keep their raw category. */
export function titleOf(crumb: Crumb, type: string): string {
  if (crumb.virtual || crumb.type === null || crumb.type === "default") {
    return crumb.category ?? "generic";
  }

  if (type === "http") {
    return "HTTP";
  }

  return (crumb.category ?? type)
    .replaceAll(".", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** What the SDK always attaches and nobody reads. */
const NOISE = new Set(["arguments", "__span", "logger"]);

/** The crumb's data worth showing, or null when there is none. */
export function dataOf(data: JsonObject): JsonObject | null {
  const rest = Object.entries(data).flatMap(([key, value]): [string, Json][] =>
    NOISE.has(key) ? [] : [[key, value]],
  );

  return rest.length === 0 ? null : Object.fromEntries(rest);
}

/** "-1.25s" before the event, for the relative time format. */
export function relative(timestamp: number, eventTime: number): string {
  const seconds = (eventTime - timestamp) / 1000;

  return seconds <= 0 ? "0s" : `-${seconds.toFixed(seconds < 10 ? 2 : 1)}s`;
}

/** The event itself, as the newest entry of its own timeline. */
export function thisEvent(event: StoredEvent): Crumb {
  const exception = event.exceptions.at(-1);
  const base = { timestamp: event.timestamp, data: null, virtual: true };

  if (exception === undefined) {
    const message = event.message?.formatted ?? event.message?.message ?? event.title;

    return { ...base, type: "info", category: "message", level: "info", message };
  }

  return {
    ...base,
    type: "error",
    category: exception.module ?? "exception",
    level: event.level,
    message: `${exception.type ?? "Error"}: ${exception.value ?? ""}`,
  };
}

export function matches(crumb: Crumb, search: string): boolean {
  const data = crumb.data === null ? "" : jsonText(crumb.data);
  const text = `${crumb.category ?? ""} ${crumb.message ?? ""} ${data}`;

  return text.toLowerCase().includes(search.toLowerCase());
}
