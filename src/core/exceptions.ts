// The `exception` interface: accepts `{values: [...]}`, a bare list, or a
// single exception object.

import type { Json, JsonObject, StoredException, StoredMechanism } from "@/shared/contract";
import {
  asArray,
  asObject,
  getArray,
  getBoolean,
  getNonEmpty,
  getObject,
  objectsIn,
} from "@/shared/json";

import { parseFrames } from "./frames";
import { scrubText } from "./scrub";
import { cut, cutOrNull, MAX_STRING } from "./trim";

const MAX_EXCEPTIONS = 20;

function parseMechanism(raw: JsonObject | null): StoredMechanism | null {
  if (raw === null) {
    return null;
  }

  return {
    type: cutOrNull(getNonEmpty(raw, "type"), 200),
    handled: getBoolean(raw, "handled"),
    synthetic: getBoolean(raw, "synthetic") ?? false,
  };
}

function parseException(raw: JsonObject): StoredException {
  const value = getNonEmpty(raw, "value");

  return {
    type: cutOrNull(getNonEmpty(raw, "type"), 200),
    value: value === null ? null : scrubText(cut(value, MAX_STRING)),
    module: cutOrNull(getNonEmpty(raw, "module"), 200),
    mechanism: parseMechanism(getObject(raw, "mechanism")),
    frames: parseFrames(getObject(raw, "stacktrace")),
  };
}

function rawExceptions(value: Json | undefined): JsonObject[] {
  const list = asArray(value);
  const single = asObject(value);

  if (list !== null) {
    return objectsIn(list);
  }

  if (single === null) {
    return [];
  }

  const values = getArray(single, "values");

  return values === null ? [single] : objectsIn(values);
}

/** Exceptions in SDK order: root cause first, the one that was raised last. */
export function parseExceptions(value: Json | undefined): StoredException[] {
  return rawExceptions(value).slice(-MAX_EXCEPTIONS).map(parseException);
}
