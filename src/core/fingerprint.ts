// Custom fingerprints. A part is literal text, `{{ default }}` (with or
// without spaces), or text holding variables like `{{ transaction }}` or
// `{{ tags.region }}`, as in Sentry's `grouping/variants.py`.

import type { StoredEvent } from "@/shared/contract";

import { culpritFrame } from "./derive";

type Value = string | number | boolean | null | undefined;

const VARIABLE = /\{\{\s*([\w.-]+)\s*\}\}/g;
const DEFAULT_PART = /^\{\{\s*default\s*\}\}$/;
const TAG_PREFIX = "tags.";

const lastException = (event: StoredEvent): StoredEvent["exceptions"][number] | undefined =>
  event.exceptions.at(-1);

const crashFrame = (event: StoredEvent): ReturnType<typeof culpritFrame> =>
  culpritFrame(event.exceptions);

const RESOLVERS = new Map<string, (event: StoredEvent) => Value>([
  ["transaction", (event) => event.transaction],
  ["message", (event) => event.message?.formatted],
  ["logger", (event) => event.logger],
  ["level", (event) => event.level],
  ["type", (event) => lastException(event)?.type],
  ["value", (event) => lastException(event)?.value],
  ["error.type", (event) => lastException(event)?.type],
  ["error.value", (event) => lastException(event)?.value],
  ["error.handled", (event) => lastException(event)?.mechanism?.handled],
  ["error.mechanism_type", (event) => lastException(event)?.mechanism?.type],
  ["module", (event) => crashFrame(event)?.module],
  ["function", (event) => crashFrame(event)?.function],
  ["filename", (event) => crashFrame(event)?.filename],
  ["path", (event) => crashFrame(event)?.absPath ?? crashFrame(event)?.filename],
  ["stack.module", (event) => crashFrame(event)?.module],
  ["stack.function", (event) => crashFrame(event)?.function],
  ["stack.filename", (event) => crashFrame(event)?.filename],
  ["stack.abs_path", (event) => crashFrame(event)?.absPath],
]);

export function isDefaultPart(part: string): boolean {
  return DEFAULT_PART.test(part.trim());
}

function resolve(name: string, event: StoredEvent): Value {
  if (name.startsWith(TAG_PREFIX)) {
    const key = name.slice(TAG_PREFIX.length);

    return event.tags.find(([tag]) => tag === key)?.[1];
  }

  return RESOLVERS.get(name.toLowerCase())?.(event);
}

/** Replaces known variables; unknown ones, and ones the event has no value for, stay as written. */
export function expandVariables(part: string, event: StoredEvent): string {
  return part.replaceAll(VARIABLE, (match, name: string) => {
    const value = resolve(name, event);

    return value === null || value === undefined ? match : String(value);
  });
}
