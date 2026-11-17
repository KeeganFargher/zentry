// Request and response helpers for the read API.

import type { ApiError, JsonObject } from "@/shared/contract";
import { asObject, parseJson } from "@/shared/json";

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

/** The request body as a JSON object, or null when it is anything else. */
export async function readObject(request: Request): Promise<JsonObject | null> {
  return asObject(parseJson(await request.text()));
}

/** A non-negative integer query parameter, or `fallback`. */
export function intParam(url: URL, name: string, fallback: number): number {
  const text = url.searchParams.get(name) ?? "";

  return /^\d{1,9}$/.test(text) ? Number(text) : fallback;
}

/** A query parameter, or null when it is absent or empty. */
export function textParam(url: URL, name: string): string | null {
  const text = url.searchParams.get(name)?.trim() ?? "";

  return text === "" ? null : text;
}

/** Cursors are opaque to clients: base64 of a few `:`-separated fields. */
export function encodeCursor(parts: (string | number)[]): string {
  return btoa(parts.join(":"));
}

export function decodeCursor(url: URL): string[] | null {
  const cursor = textParam(url, "cursor");

  if (cursor === null) {
    return null;
  }

  try {
    return atob(cursor).split(":");
  } catch {
    return null;
  }
}
