// Default data scrubbing: a reduced form of Relay's built-in rules. Applied
// before anything is stored.

import type { Json, JsonObject, Pair } from "@/shared/contract";
import { jsonKind, jsonText, JsonValue } from "@/shared/json";

import { FILTERED, scrubSecrets } from "./secrets";
import { MAX_STRING, trimJson } from "./trim";

export { FILTERED };

const SENSITIVE_KEY =
  /password|passwd|secret|api[_-]?key|access[_-]?key|auth|credentials|mysql_pwd|private[_-]?key|token|session|cookie|csrf|bearer/i;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

export function scrubText(text: string): string {
  return scrubSecrets(text);
}

export function scrubObject(source: JsonObject): JsonObject {
  const scrubbed: JsonObject = {};

  for (const [key, value] of Object.entries(source)) {
    scrubbed[key] = isSensitiveKey(key) && value !== null ? FILTERED : scrubJson(value);
  }

  return scrubbed;
}

export function scrubJson(value: Json): Json {
  const kind = jsonKind(value);

  if (kind.kind === "string") {
    return scrubText(kind.value);
  }

  if (kind.kind === "list") {
    return kind.value.map(scrubJson);
  }

  return kind.kind === "map" ? scrubObject(kind.value) : kind.value;
}

export function scrubPairs(pairs: Pair[]): Pair[] {
  return pairs.map(([key, value]) => [key, isSensitiveKey(key) ? FILTERED : scrubText(value)]);
}

/** Filters sensitive parameters in a `a=1&b=2` query string. */
export function scrubQueryString(query: string): string {
  return query
    .split("&")
    .map((part) => {
      const [key = ""] = part.split("=", 1);

      return isSensitiveKey(key) ? `${key}=${FILTERED}` : scrubText(part);
    })
    .join("&");
}

const BODY_LIMITS = { depth: 5, maxKeys: 200, maxString: MAX_STRING };

const FORM_ENCODED = /^[^=&\s]+=[^\s]*$/;

/** Body text that holds a JSON object or list; any other text is scrubbed as plain text. */
const JsonBodyText = jsonText(
  JsonValue.refine((value) => ["list", "map"].includes(jsonKind(value).kind)),
);

/**
 * Scrubs a request body. SDKs often send the body as text, so a string that
 * holds JSON or form fields is scrubbed by key like structured data.
 */
export function scrubBody(body: Json): Json {
  const kind = jsonKind(body);

  return kind.kind === "string" ? scrubBodyText(kind.value) : scrubJson(body);
}

function scrubBodyText(text: string): string {
  const parsed = JsonBodyText.safeParse(text);

  // The text was already cut to length, but not to depth: trim the parsed value
  // to the request-data limits first, or a short, deeply nested body would
  // overflow the stack in `scrubJson`.
  if (parsed.success) {
    return JSON.stringify(scrubJson(trimJson(parsed.data, BODY_LIMITS)));
  }

  return FORM_ENCODED.test(text) ? scrubQueryString(text) : scrubText(text);
}
