// Classifies a JSON value for display. The one UI file allowed to use
// runtime `typeof`, for the same reason as src/shared/json.ts.

import type { Json } from "@contract";

export type JsonNode =
  | { kind: "scalar"; text: string; quoted: boolean }
  | { kind: "list"; items: Json[] }
  | { kind: "map"; entries: [key: string, value: Json][] };

export function describeJson(value: Json): JsonNode {
  if (Array.isArray(value)) {
    return { kind: "list", items: value };
  }

  if (value !== null && typeof value === "object") {
    return { kind: "map", entries: Object.entries(value) };
  }

  return { kind: "scalar", text: String(value), quoted: typeof value === "string" };
}

/** A short one-line rendering, for table cells. */
export function jsonText(value: Json): string {
  const node = describeJson(value);

  return node.kind === "scalar" ? node.text : JSON.stringify(value);
}

/** A string or number field of a JSON object, as text; null for anything else. */
export function getText(value: Json, key: string): string | null {
  const node = describeJson(value);
  const field = node.kind === "map" ? node.entries.find(([name]) => name === key)?.[1] : undefined;
  const leaf = field === undefined || field === null ? null : describeJson(field);

  return leaf?.kind === "scalar" ? leaf.text : null;
}
