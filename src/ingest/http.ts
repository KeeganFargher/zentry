// Response helpers for the ingest endpoints. Every response carries CORS
// headers, errors included, because browser SDKs read them.

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "content-type, content-encoding, x-sentry-auth, sentry-trace, baggage, authentication",
  "Access-Control-Expose-Headers": "x-sentry-rate-limits, retry-after",
  "Access-Control-Max-Age": "86400",
};

export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/** The event was queued under `eventId`. */
export function accepted(eventId: string): Response {
  return Response.json({ id: eventId }, { headers: CORS_HEADERS });
}

/** The request was fine but held nothing we keep (a transaction, a session). */
export function acceptedNothing(): Response {
  return Response.json({}, { headers: CORS_HEADERS });
}

export function rejected(status: number, detail: string): Response {
  return Response.json({ detail }, { status, headers: CORS_HEADERS });
}

/** The scope and reason code of a limit, as Relay writes them in X-Sentry-Rate-Limits. */
export type LimitCause = {
  scope: "organization" | "project" | "key";
  reason: "org_quota" | "project_quota" | "spike_protection" | "key_quota";
};

/**
 * 429 that tells the SDK to stop sending for `seconds`. The categories field
 * is left empty, which means every category: the SDK then also stops sending
 * sessions and transactions, which Zentry drops anyway but which still cost a
 * Worker request each.
 */
export function rateLimited(seconds: number, cause: LimitCause): Response {
  const wait = String(Math.max(1, Math.ceil(seconds)));

  return Response.json(
    { detail: "rate limited" },
    {
      status: 429,
      headers: {
        ...CORS_HEADERS,
        "Retry-After": wait,
        "X-Sentry-Rate-Limits": `${wait}::${cause.scope}:${cause.reason}`,
      },
    },
  );
}

export function unavailable(): Response {
  return Response.json(
    { detail: "ingest unavailable" },
    { status: 503, headers: { ...CORS_HEADERS, "Retry-After": "30" } },
  );
}
