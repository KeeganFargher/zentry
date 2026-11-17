// Default data scrubbing: a reduced form of Relay's built-in rules. Applied
// before anything is stored.

import type { Json, JsonObject, Pair } from "@/shared/contract";
import { asArray, asObject, asString, parseJson } from "@/shared/json";

import { FILTERED, scrubSecrets } from "./secrets";

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
  const text = asString(value);
  const list = asArray(value);
  const dictionary = asObject(value);

  if (text !== null) {
    return scrubText(text);
  }

  if (list !== null) {
    return list.map(scrubJson);
  }

  return dictionary === null ? value : scrubObject(dictionary);
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

const FORM_ENCODED = /^[^=&\s]+=[^\s]*$/;

/**
 * Scrubs a request body. SDKs often send the body as text, so a string that
 * holds JSON or form fields is scrubbed by key like structured data.
 */
export function scrubBody(body: Json): Json {
  const text = asString(body);

  if (text === null) {
    return scrubJson(body);
  }

  const parsed = parseJson(text) ?? null;

  if (asObject(parsed) !== null || asArray(parsed) !== null) {
    return JSON.stringify(scrubJson(parsed));
  }

  return FORM_ENCODED.test(text) ? scrubQueryString(text) : scrubText(text);
}
