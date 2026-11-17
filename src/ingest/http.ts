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

export function accepted(eventId: string | null): Response {
  return Response.json(eventId === null ? {} : { id: eventId }, { headers: CORS_HEADERS });
}

export function rejected(status: number, detail: string): Response {
  return Response.json({ detail }, { status, headers: CORS_HEADERS });
}

/** 429 that tells the SDK to stop sending for `seconds`. */
export function rateLimited(seconds: number): Response {
  const wait = String(Math.max(1, Math.ceil(seconds)));

  return Response.json(
    { detail: "rate limited" },
    {
      status: 429,
      headers: { ...CORS_HEADERS, "Retry-After": wait, "X-Sentry-Rate-Limits": `${wait}::project` },
    },
  );
}

export function unavailable(): Response {
  return Response.json(
    { detail: "queue unavailable" },
    { status: 503, headers: { ...CORS_HEADERS, "Retry-After": "30" } },
  );
}
