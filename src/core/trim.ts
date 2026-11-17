// Size limits for free-form parts of an event (extra, contexts, vars).

import type { Json, JsonObject } from "@/shared/contract";
import { asArray, asObject, asString } from "@/shared/json";

export type TrimLimits = { depth: number; maxKeys: number; maxString: number };

export const MAX_STRING = 8192;
export const MAX_LINE = 512;

export function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function cutOrNull(text: string | null, max: number): string | null {
  return text === null ? null : cut(text, max);
}

export function trimObject(source: JsonObject, limits: TrimLimits): JsonObject {
  const deeper = { ...limits, depth: limits.depth - 1 };
  const trimmed: JsonObject = {};

  for (const [key, value] of Object.entries(source).slice(0, limits.maxKeys)) {
    trimmed[cut(key, 200)] = trimJson(value, deeper);
  }

  return trimmed;
}

export function trimJson(value: Json, limits: TrimLimits): Json {
  const text = asString(value);
  const list = asArray(value);
  const dictionary = asObject(value);

  if (text !== null) {
    return cut(text, limits.maxString);
  }

  if (list !== null) {
    const deeper = { ...limits, depth: limits.depth - 1 };

    return limits.depth <= 0
      ? "[…]"
      : list.slice(0, limits.maxKeys).map((item) => trimJson(item, deeper));
  }

  if (dictionary !== null) {
    return limits.depth <= 0 ? "{…}" : trimObject(dictionary, limits);
  }

  return value;
}
