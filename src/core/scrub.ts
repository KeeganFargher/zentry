// Default data scrubbing: a reduced form of Relay's built-in rules. Applied
// before anything is stored.

import type { Json, JsonObject, Pair } from "@/shared/contract";
import { asArray, asObject, asString } from "@/shared/json";

export const FILTERED = "[Filtered]";

const SENSITIVE_KEY =
  /password|passwd|secret|api_?key|apikey|auth|credentials|mysql_pwd|private_?key|token|session|cookie|csrf|bearer/i;

const CARD_CANDIDATE = /\b\d(?:[ -]?\d){12,18}\b/g;
const CARD_PREFIX = /^(?:4\d{12}(?:\d{3})?|5[1-5]\d{14}|3[47]\d{13}|6(?:011|5\d{2})\d{12})$/;

function passesLuhn(digits: string): boolean {
  let sum = 0;

  for (let index = 0; index < digits.length; index += 1) {
    const digit = Number(digits[digits.length - 1 - index]);
    const doubled = index % 2 === 1 ? digit * 2 : digit;

    sum += doubled > 9 ? doubled - 9 : doubled;
  }

  return sum % 10 === 0;
}

function isCardNumber(candidate: string): boolean {
  const digits = candidate.replaceAll(/[ -]/g, "");

  return CARD_PREFIX.test(digits) && passesLuhn(digits);
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

export function scrubText(text: string): string {
  return text.replace(CARD_CANDIDATE, (candidate) =>
    isCardNumber(candidate) ? FILTERED : candidate,
  );
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
