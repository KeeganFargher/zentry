// The single place where untrusted JSON is narrowed into typed values.
// Everything else in the codebase works on the results and never sees
// `unknown`. Runtime `typeof` checks are allowed in this file only.

import type { Json, JsonObject } from "./contract";

export function parseJson(text: string): Json | undefined {
  try {
    // SAFETY: JSON.parse can only produce the value kinds that make up `Json`.
    return JSON.parse(text) as Json;
  } catch {
    return undefined;
  }
}

export function asObject(value: Json | undefined): JsonObject | null {
  if (value === null || value === undefined || typeof value !== "object") {
    return null;
  }

  return Array.isArray(value) ? null : value;
}

export function asArray(value: Json | undefined): Json[] | null {
  return Array.isArray(value) ? value : null;
}

export function asString(value: Json | undefined): string | null {
  return typeof value === "string" ? value : null;
}

export function asNumber(value: Json | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function asBoolean(value: Json | undefined): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** Strings as they are; numbers and booleans rendered; everything else null. */
export function asText(value: Json | undefined): string | null {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return null;
}

export function getObject(source: JsonObject, key: string): JsonObject | null {
  return asObject(source[key]);
}

export function getArray(source: JsonObject, key: string): Json[] | null {
  return asArray(source[key]);
}

export function getString(source: JsonObject, key: string): string | null {
  return asString(source[key]);
}

export function getNumber(source: JsonObject, key: string): number | null {
  return asNumber(source[key]);
}

export function getBoolean(source: JsonObject, key: string): boolean | null {
  return asBoolean(source[key]);
}

export function getText(source: JsonObject, key: string): string | null {
  return asText(source[key]);
}

/** A non-empty string, or null. */
export function getNonEmpty(source: JsonObject, key: string): string | null {
  const text = getString(source, key);

  return text === null || text === "" ? null : text;
}

export function objectsIn(values: Json[] | null): JsonObject[] {
  const found: JsonObject[] = [];

  for (const value of values ?? []) {
    const item = asObject(value);

    if (item !== null) {
      found.push(item);
    }
  }

  return found;
}

export function stringsIn(values: Json[] | null): string[] {
  const found: string[] = [];

  for (const value of values ?? []) {
    const item = asText(value);

    if (item !== null) {
      found.push(item);
    }
  }

  return found;
}
