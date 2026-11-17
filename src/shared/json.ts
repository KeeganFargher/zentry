// JSON at the edges of the system. Text from outside (a request body, a queue
// payload, a D1 column) is turned into a typed value here, once, by a schema;
// nothing downstream re-checks what a schema has already proven.

import { z } from "zod";

import type { Json, JsonObject } from "./contract";

/**
 * A JSON value of any kind, checked only for presence. Every value a schema
 * sees came out of `JSON.parse` (see `jsonText`), so it is `Json` by
 * construction. Re-walking it with `z.json()` would recurse as deep as the
 * sender nested it, before the trimmers cap depth, and a small but deeply
 * nested payload would overflow the stack. The trimmers walk it, bounded.
 */
export const JsonValue: z.ZodType<Json> = z.custom<Json>((value) => value !== undefined);

export const JsonRecord: z.ZodType<JsonObject> = z.record(z.string(), JsonValue);

/**
 * Text that must hold JSON matching `schema`. Invalid JSON is reported as a
 * schema issue rather than thrown, so every caller handles one failure shape.
 */
export function jsonText<T extends z.ZodType>(schema: T): z.ZodType<z.output<T>, string> {
  // SAFETY: a schema checks whatever it is given at runtime; its input type
  // only records what it was written to expect, and JSON is what it gets here.
  const target = schema as z.ZodType<z.output<T>, Json>;

  return z
    .string()
    .transform((text, context): Json => {
      try {
        // SAFETY: JSON.parse can only produce the value kinds that make up `Json`.
        return JSON.parse(text) as Json;
      } catch {
        context.addIssue({ code: "custom", message: "not valid JSON" });

        return z.NEVER;
      }
    })
    .pipe(target);
}

export type JsonKind =
  | { kind: "string"; value: string }
  | { kind: "list"; value: Json[] }
  | { kind: "map"; value: JsonObject }
  | { kind: "scalar"; value: number | boolean | null };

/**
 * Tells the members of the `Json` union apart, for code that walks free-form
 * data (extra, contexts, vars) to trim or scrub it. This only discriminates
 * an already-typed value; it is not validation.
 */
export function jsonKind(value: Json): JsonKind {
  if (typeof value === "string") {
    return { kind: "string", value };
  }

  if (Array.isArray(value)) {
    return { kind: "list", value };
  }

  return value !== null && typeof value === "object"
    ? { kind: "map", value }
    : { kind: "scalar", value };
}
