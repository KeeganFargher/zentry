// The slice of Sentry's issue search syntax that sentry-cli's `issues list
// --query` can use against Zentry (DESIGN.md §20.2), and Sentry's status names.

import { z } from "zod";

import type { IssueStatus, Pair } from "@/shared/contract";

import { InvalidRequest } from "./http";

export type Search = {
  status: IssueStatus | null;
  level: string | null;
  tag: Pair | null;
  text: string;
};

const TO_STATUS = {
  unresolved: "unresolved",
  resolved: "resolved",
  ignored: "ignored",
  muted: "ignored",
  archived: "ignored",
} as const satisfies Record<string, IssueStatus>;

/** Sentry calls ignoring "muted" in older clients and "archived" in newer ones. */
export const SentryStatus = z
  .enum(["unresolved", "resolved", "ignored", "muted", "archived"])
  .transform((status): IssueStatus => TO_STATUS[status]);

const QUALIFIER = /^([\w.-]+):(\S+)$/;

const SentryLevel = z.enum(["fatal", "error", "warning", "info", "debug"]);

/**
 * Sentry search keys that are not tags. Treated as a tag they would search
 * for a tag nobody sets and answer with an empty list, which reads as "no
 * such issues"; refusing them says the search was not understood.
 */
const NOT_TAGS = new Set([
  "age",
  "assigned",
  "assigned_or_suggested",
  "bookmarks",
  "event.timestamp",
  "firstRelease",
  "firstSeen",
  "has",
  "issue",
  "issue.category",
  "issue.priority",
  "issue.type",
  "lastSeen",
  "message",
  "release.stage",
  "subscribed",
  "timesSeen",
]);

/** Values that are Sentry syntax (lists, comparisons, quoting), not literal values. */
const SYNTAX_VALUE = /^[[<>="]/;

/**
 * The part of Sentry's search syntax our issue list can answer: `is:<status>`,
 * `level:<level>`, one `<tag>:<value>` (Sentry treats an unknown key as a
 * tag), and free text, matched against title and culprit. Anything else
 * (quotes, negation, lists, comparisons, a repeated qualifier, a key that is
 * not a tag) is refused rather than answered wrongly: `is:assigned` returning
 * every issue, or `has:user` returning none, would each read as an answer.
 */
export function parseSearch(query: string): Search {
  if (query.includes('"')) {
    throw new InvalidRequest("quoted search terms are not supported");
  }

  const search: Search = { status: null, level: null, tag: null, text: "" };
  const words: string[] = [];

  for (const token of query.split(/\s+/).filter((word) => word !== "")) {
    const [, key, value] = QUALIFIER.exec(token) ?? [];

    if (key !== undefined && value !== undefined) {
      applyQualifier(search, key, value);
    } else if (token.startsWith("!") && token.includes(":")) {
      throw new InvalidRequest(`negated search terms are not supported: ${token}`);
    } else {
      words.push(token);
    }
  }

  return { ...search, text: words.join(" ") };
}

/** A qualifier's value, parsed by its schema. */
function valueOf<T>(key: string, schema: z.ZodType<T, string>, value: string): T {
  const parsed = schema.safeParse(value);

  if (!parsed.success) {
    throw new InvalidRequest(`${key}:${value} is not supported`);
  }

  return parsed.data;
}

/** One `key:value` term of a search, applied to it. */
function applyQualifier(search: Search, key: string, value: string): void {
  if (NOT_TAGS.has(key) || SYNTAX_VALUE.test(value)) {
    throw new InvalidRequest(`${key}:${value} is not supported in Zentry's search`);
  }

  const repeated =
    (key === "is" && search.status !== null) || (key === "level" && search.level !== null);

  if (repeated) {
    throw new InvalidRequest(`${key}: can appear only once in a search`);
  }

  if (key === "is") {
    search.status = valueOf(key, SentryStatus, value);
  } else if (key === "level") {
    search.level = valueOf(key, SentryLevel, value);
  } else if (search.tag === null) {
    search.tag = [key, value];
  } else {
    throw new InvalidRequest(`only one tag can be searched at a time, not ${key}:${value} as well`);
  }
}
