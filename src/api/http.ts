// Request and response helpers for the read API.
//
// Request input (JSON bodies, query strings, cursors) is validated by a schema
// at the top of each handler. Our own UI is the only client, so input that does
// not match is a bug worth surfacing: it is refused with a 400 that says what
// was wrong, never coerced into a default.

import { z } from "zod";

import type { ApiError } from "@/shared/contract";
import { jsonText } from "@/shared/json";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** True for requests to a local dev server. Never true behind a Cloudflare route. */
export function isLocal(url: URL): boolean {
  return LOCAL_HOSTS.has(url.hostname);
}

export function notFound(): Response {
  return Response.json({ detail: "not found" } satisfies ApiError, { status: 404 });
}

export function badRequest(detail: string): Response {
  return Response.json({ detail } satisfies ApiError, { status: 400 });
}

export function unauthorized(): Response {
  return Response.json({ detail: "not signed in" } satisfies ApiError, { status: 401 });
}

export function noContent(): Response {
  return new Response(null, { status: 204 });
}

/** Thrown when request input fails its schema; the router answers it with a 400. */
export class InvalidRequest extends Error {}

type RequestInput = string | Record<string, string | string[]>;

function parsed<T extends z.ZodType>(schema: T, input: RequestInput): z.output<T> {
  const result = schema.safeParse(input);

  if (!result.success) {
    throw new InvalidRequest(z.prettifyError(result.error));
  }

  return result.data;
}

/** The JSON body, validated by `schema`. */
export async function readBody<T extends z.ZodType>(
  request: Request,
  schema: T,
): Promise<z.output<T>> {
  return parsed(jsonText(schema), await request.text());
}

/**
 * The query string, validated by `schema`. Empty values count as absent, as
 * the UI clears a filter by sending it empty. A repeated name becomes a list.
 */
export function readQuery<T extends z.ZodType>(url: URL, schema: T): z.output<T> {
  const query: Record<string, string | string[]> = {};

  for (const [name, raw] of url.searchParams) {
    const value = raw.trim();
    const existing = query[name];

    if (value !== "") {
      query[name] = existing === undefined ? value : [existing, value].flat();
    }
  }

  return parsed(schema, query);
}

/** A decimal id such as a project id: a positive integer. */
export const IdParam = z
  .string()
  .regex(/^[0-9]{1,15}$/, "must be a positive integer")
  .transform(Number)
  .pipe(z.number().positive());

/** A whole number in a query string; at most 15 digits, so it is a safe integer. */
export const IntParam = z
  .string()
  .regex(/^\d{1,15}$/, "must be a whole number")
  .transform(Number);

/** Cursors are opaque to clients: base64 of a few `:`-separated fields. */
export function encodeCursor(parts: (string | number)[]): string {
  return btoa(parts.join(":"));
}

/** A cursor made by `encodeCursor`, as its fields; pipe it into a schema for them. */
export const CursorParam = z.string().transform((text, context): string[] => {
  try {
    return atob(text).split(":");
  } catch {
    context.addIssue({ code: "custom", message: "cursor is not valid base64" });

    return z.NEVER;
  }
});
