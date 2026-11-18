// The event's tags as the web lists them (ui/src/pages/event-tags.tsx): its
// own tags plus the ones Zentry derives and indexes (browser, os, user…),
// and the tabs that split them into custom, application and client.

import type { Pair, StoredEvent } from "@contract";

import { getText } from "./json";

function context(event: StoredEvent, name: string, field: string): string | null {
  const value = event.contexts[name];

  return value === undefined ? null : getText(value, field);
}

function nameAndVersion(event: StoredEvent, name: string): string | null {
  const label = context(event, name, "name");
  const version = context(event, name, "version");

  if (label === null) {
    return null;
  }

  return version === null ? label : `${label} ${version}`;
}

const USER_FIELDS: [prefix: string, field: string][] = [
  ["id", "id"],
  ["email", "email"],
  ["username", "username"],
  ["ip", "ip_address"],
];

function userTag(event: StoredEvent): string | null {
  const user = event.user;

  if (user === null) {
    return null;
  }

  for (const [prefix, field] of USER_FIELDS) {
    const value = getText(user, field);

    if (value !== null) {
      return `${prefix}:${value}`;
    }
  }

  return null;
}

/** The same derived tags the Worker indexes (src/core/tags.ts). */
type Candidate = [key: string, value: string | null];

function mechanismTags(event: StoredEvent): Candidate[] {
  const last = event.exceptions.at(-1)?.mechanism ?? null;
  const handled = last?.handled ?? null;

  return [
    ["handled", handled === null ? null : handled ? "yes" : "no"],
    ["mechanism", last?.type ?? null],
  ];
}

function derivedTags(event: StoredEvent): Candidate[] {
  return [
    ["level", event.level],
    ["environment", event.environment],
    ["release", event.release],
    ["server_name", event.serverName],
    ["logger", event.logger ?? null],
    ["transaction", event.transaction],
    ["browser", nameAndVersion(event, "browser")],
    ["browser.name", context(event, "browser", "name")],
    ["os", nameAndVersion(event, "os")],
    ["os.name", context(event, "os", "name")],
    ["runtime", nameAndVersion(event, "runtime")],
    ["device", context(event, "device", "model") ?? context(event, "device", "family")],
    ["url", event.request?.url ?? null],
    ["user", userTag(event)],
    ...mechanismTags(event),
  ];
}

/** Built-in tags first, then the event's own; the first value for a key wins. */
export function eventTags(event: StoredEvent): Pair[] {
  const tags = new Map<string, string>();

  for (const [key, value] of [...derivedTags(event), ...event.tags]) {
    if (value !== null && value !== "" && !tags.has(key)) {
      tags.set(key, value);
    }
  }

  return [...tags].sort(([left], [right]) => left.localeCompare(right));
}

const APPLICATION = new Set([
  "environment",
  "release",
  "dist",
  "transaction",
  "logger",
  "level",
  "handled",
  "mechanism",
  "server_name",
  "url",
]);

const CLIENT = new Set([
  "browser",
  "browser.name",
  "os",
  "os.name",
  "device",
  "device.family",
  "runtime",
  "runtime.name",
  "user",
  "client_os",
  "client_os.name",
]);

export const TABS = [
  ["all", "All"],
  ["custom", "Custom"],
  ["application", "Application"],
  ["client", "Client"],
] as const;

export type Tab = (typeof TABS)[number][0];

export function inTab(tab: Tab, key: string, own: Set<string>): boolean {
  switch (tab) {
    case "application": {
      return APPLICATION.has(key);
    }

    case "client": {
      return CLIENT.has(key);
    }

    case "custom": {
      return own.has(key) && !APPLICATION.has(key) && !CLIENT.has(key);
    }

    default: {
      return true;
    }
  }
}
