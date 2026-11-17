// Schema building blocks for data that arrives from SDKs. Sentry's rule, which
// SDKs rely on, is that a field with the wrong type is dropped and the rest of
// the event is kept; these encode that rule so it is stated once, at the
// boundary, instead of as null checks spread through the code that follows.

import { z } from "zod";

/** A field that is null when it is absent or of the wrong type. */
export function lenient<T extends z.ZodType>(schema: T): z.ZodCatch<z.ZodNullable<T>> {
  return schema.nullable().catch(null);
}

type ListOf<T extends z.ZodType> = z.ZodPipe<
  z.ZodArray<z.ZodCatch<z.ZodNullable<T>>>,
  z.ZodTransform<z.output<T>[], (z.output<T> | null)[]>
>;

/** A list whose invalid items are dropped. Fails when the value is not a list at all. */
export function listOf<T extends z.ZodType>(item: T): ListOf<T> {
  return z
    .array(lenient(item))
    .transform((items) => items.filter((entry): entry is z.output<T> => entry !== null));
}

/** A list whose invalid items are dropped; empty when the value is not a list. */
export function lenientList<T extends z.ZodType>(item: T): z.ZodCatch<ListOf<T>> {
  return listOf(item).catch([]);
}

/** A flag that is false unless the SDK sent `true`. */
export const Flag = z.boolean().catch(false);

/** A non-empty string. SDKs send "" for "not set". */
export const Label = z.string().min(1);

/** Strings as they are; numbers and booleans rendered, as Sentry shows them. */
export const Text = z.union([z.string(), z.number(), z.boolean()]).transform(String);
