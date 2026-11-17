// The `exception` interface: accepts `{values: [...]}`, a bare list, or a
// single exception object.

import type {
  Json,
  JsonObject,
  StoredException,
  StoredFrame,
  StoredMechanism,
} from "@/shared/contract";
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
    exceptionGroup: getBoolean(raw, "is_exception_group") ?? false,
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

function threadList(raw: JsonObject): JsonObject[] {
  const threads = raw["threads"];
  const wrapped = asObject(threads);
  const list = wrapped === null ? asArray(threads) : getArray(wrapped, "values");

  return objectsIn(list);
}

/** The stack of the thread that crashed, else the current one, else the first with frames. */
function threadFrames(raw: JsonObject): StoredFrame[] {
  const withStacks = threadList(raw)
    .map((thread) => ({ thread, frames: parseFrames(getObject(thread, "stacktrace")) }))
    .filter(({ frames }) => frames.length > 0);

  const chosen =
    withStacks.find(({ thread }) => getBoolean(thread, "crashed") === true) ??
    withStacks.find(({ thread }) => getBoolean(thread, "current") === true) ??
    withStacks[0];

  return chosen?.frames ?? [];
}

/**
 * The event's exceptions. Some SDKs keep the stack outside `exception`, in
 * `threads` or a top-level `stacktrace`. When no exception has frames of its
 * own, that stack goes on the last exception, or on a bare one with no type or
 * value when the event has none, so the trace shows and the event still groups
 * by where it happened.
 */
export function parseEventExceptions(raw: JsonObject): StoredException[] {
  const exceptions = parseExceptions(raw["exception"]);

  if (exceptions.some((exception) => exception.frames.length > 0)) {
    return exceptions;
  }

  const topLevel = parseFrames(getObject(raw, "stacktrace"));
  const frames = topLevel.length > 0 ? topLevel : threadFrames(raw);
  const last = exceptions.at(-1);

  if (frames.length === 0) {
    return exceptions;
  }

  const stacked: StoredException = last ?? {
    type: null,
    value: null,
    module: null,
    mechanism: null,
    frames: [],
  };

  return [...exceptions.slice(0, -1), { ...stacked, frames }];
}
