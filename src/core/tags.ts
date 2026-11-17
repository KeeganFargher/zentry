// The tags that are counted per issue, and the user label shown in lists.

import type { Pair, StoredEvent } from "@/shared/contract";

import { scrubText } from "./scrub";
import { cut } from "./trim";
import { majorVersion } from "./useragent";

const MAX_INDEXED_TAGS = 50;
const MAX_VALUE = 200;

export type ContextFacts = {
  name: string | null;
  version: string | null;
  model: string | null;
  family: string | null;
};

export type UserFacts = {
  id: string | null;
  email: string | null;
  username: string | null;
  ipAddress: string | null;
};

/**
 * What tags are built from, pulled out of the event's free-form `contexts`
 * and `user` while they were still typed (see core/wire.ts), so nothing here
 * has to look inside arbitrary JSON.
 */
export type TagFacts = {
  browser: ContextFacts | null;
  os: ContextFacts | null;
  runtime: ContextFacts | null;
  device: ContextFacts | null;
  user: UserFacts;
};

type Candidate = [key: string, value: string | null];

function nameAndVersion(context: ContextFacts): string | null {
  if (context.name === null) {
    return null;
  }

  return context.version === null ? context.name : `${context.name} ${context.version}`;
}

function browserTag(browser: ContextFacts): string | null {
  if (browser.name === null) {
    return null;
  }

  return browser.version === null
    ? browser.name
    : `${browser.name} ${majorVersion(browser.version)}`;
}

function userTag(user: UserFacts): string | null {
  const fields: [prefix: string, value: string | null][] = [
    ["id", user.id],
    ["email", user.email],
    ["username", user.username],
    ["ip", user.ipAddress],
  ];

  for (const [prefix, value] of fields) {
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

function eventTags(event: StoredEvent): Candidate[] {
  return [
    ["level", event.level],
    ["environment", event.environment],
    ["release", event.release],
    ["server_name", event.serverName],
    ["logger", event.logger ?? null],
    ["transaction", event.transaction],
  ];
}

function browserTags(browser: ContextFacts): Candidate[] {
  return [
    ["browser", browserTag(browser)],
    ["browser.name", browser.name],
  ];
}

function osTags(os: ContextFacts): Candidate[] {
  return [
    ["os", nameAndVersion(os)],
    ["os.name", os.name],
  ];
}

// A context the event lacks adds no candidates; its tags are simply absent.
function factTags(facts: TagFacts): Candidate[] {
  const { browser, os, runtime, device } = facts;

  return [
    ...(browser === null ? [] : browserTags(browser)),
    ...(os === null ? [] : osTags(os)),
    ...(runtime === null ? [] : [["runtime", nameAndVersion(runtime)] satisfies Candidate]),
    ...(device === null ? [] : [["device", device.model ?? device.family] satisfies Candidate]),
  ];
}

function requestTags(event: StoredEvent, facts: TagFacts): Candidate[] {
  return [
    ["url", event.request?.url ?? null],
    ["user", userTag(facts.user)],
    ["handled", handledTag(event)],
    ["mechanism", event.exceptions.at(-1)?.mechanism?.type ?? null],
  ];
}

/** In this order, which is the order they are kept in when the limit is hit. */
function builtInTags(event: StoredEvent, facts: TagFacts): Candidate[] {
  return [...eventTags(event), ...factTags(facts), ...requestTags(event, facts)];
}

/** Built-in tags first, then the event's own. The first value for a key wins. */
export function indexedTags(event: StoredEvent, facts: TagFacts): Pair[] {
  const tags = new Map<string, string>();

  for (const [key, value] of [...builtInTags(event, facts), ...event.tags]) {
    if (value !== null && value !== "" && !tags.has(key) && tags.size < MAX_INDEXED_TAGS) {
      // Facts come from the SDK unscrubbed; tag values are stored, so they are scrubbed here.
      tags.set(key, cut(scrubText(value), MAX_VALUE));
    }
  }

  return [...tags];
}

export function userLabel(user: UserFacts): string | null {
  const found = user.email ?? user.username ?? user.id ?? user.ipAddress;

  return found === null ? null : cut(scrubText(found), MAX_VALUE);
}
