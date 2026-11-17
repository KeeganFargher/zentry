// Size limits for free-form parts of an event (extra, contexts, vars).

import type { Json, JsonObject } from "@/shared/contract";
import { jsonKind } from "@/shared/json";

export type TrimLimits = { depth: number; maxKeys: number; maxString: number };

export const MAX_STRING = 8192;
export const MAX_LINE = 512;

export function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
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
  const kind = jsonKind(value);
  const deeper = { ...limits, depth: limits.depth - 1 };

  if (kind.kind === "string") {
    return cut(kind.value, limits.maxString);
  }

  if (kind.kind === "list") {
    return limits.depth <= 0
      ? "[…]"
      : kind.value.slice(0, limits.maxKeys).map((item) => trimJson(item, deeper));
  }

  if (kind.kind === "map") {
    return limits.depth <= 0 ? "{…}" : trimObject(kind.value, limits);
  }

  return kind.value;
}
