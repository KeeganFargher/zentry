// JSON text from outside the app, checked by a schema where it is read. As
// src/shared/json.ts on the Worker, which the app cannot import at runtime
// (Metro never resolves outside mobile/; only `import type` crosses).

import type { Json } from "@contract";
import { z } from "zod";

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
