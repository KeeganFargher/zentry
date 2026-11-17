// The tags that are counted per issue, and the user label shown in lists.

import type { JsonObject, Pair, StoredEvent } from "@/shared/contract";
import { getObject, getText } from "@/shared/json";

import { cut } from "./trim";
import { majorVersion } from "./useragent";

const MAX_INDEXED_TAGS = 50;
const MAX_VALUE = 200;

type Candidate = [key: string, value: string | null];

function contextField(event: StoredEvent, name: string, field: string): string | null {
  const context = getObject(event.contexts, name);

  return context === null ? null : getText(context, field);
}

function nameAndVersion(event: StoredEvent, name: string): string | null {
  const title = contextField(event, name, "name");
  const version = contextField(event, name, "version");

  return title === null || version === null ? title : `${title} ${version}`;
}

function browserTag(event: StoredEvent): string | null {
  const name = contextField(event, "browser", "name");
  const major = majorVersion(contextField(event, "browser", "version"));

  return name === null || major === null ? name : `${name} ${major}`;
}

function userField(user: JsonObject | null, field: string): string | null {
  const value = user === null ? null : getText(user, field);

  return value === "" ? null : value;
}

function userTag(user: JsonObject | null): string | null {
  const fields: [prefix: string, field: string][] = [
    ["id", "id"],
    ["email", "email"],
    ["username", "username"],
    ["ip", "ip_address"],
  ];

  for (const [prefix, field] of fields) {
    const value = userField(user, field);

    if (value !== null) {
      return `${prefix}:${value}`;
    }
  }

  return null;
}

function handledTag(event: StoredEvent): string | null {
  const handled = event.exceptions.at(-1)?.mechanism?.handled ?? null;

  if (handled === null) {
    return null;
  }

  return handled ? "yes" : "no";
}

function builtInTags(event: StoredEvent): Candidate[] {
  return [
    ["level", event.level],
    ["environment", event.environment],
    ["release", event.release],
    ["server_name", event.serverName],
    ["transaction", event.transaction],
    ["browser", browserTag(event)],
    ["browser.name", contextField(event, "browser", "name")],
    ["os", nameAndVersion(event, "os")],
    ["os.name", contextField(event, "os", "name")],
    ["runtime", nameAndVersion(event, "runtime")],
    ["device", contextField(event, "device", "model") ?? contextField(event, "device", "family")],
    ["url", event.request?.url ?? null],
    ["user", userTag(event.user)],
    ["handled", handledTag(event)],
    ["mechanism", event.exceptions.at(-1)?.mechanism?.type ?? null],
  ];
}

/** Built-in tags first, then the event's own. The first value for a key wins. */
export function indexedTags(event: StoredEvent): Pair[] {
  const tags = new Map<string, string>();

  for (const [key, value] of [...builtInTags(event), ...event.tags]) {
    if (value !== null && value !== "" && !tags.has(key) && tags.size < MAX_INDEXED_TAGS) {
      tags.set(key, cut(value, MAX_VALUE));
    }
  }

  return [...tags];
}

export function userLabel(user: JsonObject | null): string | null {
  const fields = ["email", "username", "id", "ip_address"];
  const found = fields.map((field) => userField(user, field)).find((value) => value !== null);

  return found === undefined ? null : cut(found, MAX_VALUE);
}
