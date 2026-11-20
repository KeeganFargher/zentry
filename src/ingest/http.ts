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

/**
 * The data categories Zentry drops on arrival, as SDKs name them in
 * X-Sentry-Rate-Limits. Both the JS and .NET SDKs match a limit against the
 * item's data category, not its envelope item type, so a client report is
 * `internal`, a log `log_item` and a statsd item `metric_bucket`.
 *
 * Never list `error` (events) or `monitor` (cron check-ins): Zentry keeps
 * those, and an SDK would stop sending them. `default` stays out too: the JS
 * and .NET SDKs give it only to `user_report`, which Zentry drops, but .NET
 * also gives it to every item type it does not know, and an SDK we have not
 * read may put events there; the rare user report costs less than that risk.
 * Nor may the list be empty, which means every category.
 */
export const DROPPED_CATEGORIES = [
  "transaction",
  "span",
  "session",
  "internal",
  "profile",
  "profile_chunk",
  "replay",
  "attachment",
  "feedback",
  "log_item",
  "trace_metric",
  "metric_bucket",
  // CSP and other browser security reports, from the JS SDK's raw_security items.
  "security",
] as const;

/**
 * How long an SDK holds back the dropped categories. Each item an SDK sends
 * in them still costs a Worker request, and an SDK with tracing on sends one
 * per request it serves, so without this a busy API costs hundreds of
 * thousands of requests a week for nothing. An hour keeps that to about one
 * envelope per category per hour per SDK process; a longer window saves
 * little more, and would hold the SDKs back for as long should Zentry ever
 * start keeping one of these categories.
 */
const DROPPED_FOR_SECONDS = 3600;

// No reason code: Relay's are for quotas, and SDKs ignore the field.
const DROPPED_LIMIT = `${DROPPED_FOR_SECONDS}:${DROPPED_CATEGORIES.join(";")}:organization`;

// Every 200 from ingest carries the limit, so whatever an SDK sends first
// teaches it: it sends at most one envelope per dropped category before it
// holds back, and each later 200 extends the hour.
const OK_HEADERS = { ...CORS_HEADERS, "X-Sentry-Rate-Limits": DROPPED_LIMIT };

export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/** The event was queued under `eventId`. */
export function accepted(eventId: string): Response {
  return Response.json({ id: eventId }, { headers: OK_HEADERS });
}

/** The request was fine but held nothing we keep (a transaction, a session). */
export function acceptedNothing(): Response {
  return Response.json({}, { headers: OK_HEADERS });
}

export function rejected(status: number, detail: string): Response {
  return Response.json({ detail }, { status, headers: CORS_HEADERS });
}

/** The scope and reason code of a limit, as Relay writes them in X-Sentry-Rate-Limits. */
export type LimitCause = {
  scope: "organization" | "project" | "key";
  reason: "org_quota" | "project_quota" | "spike_protection" | "key_quota" | "monitor_rate_limit";
};

/**
 * 429 that tells the SDK to stop sending for `seconds`. The categories field
 * is left empty, which means every category: the SDK then also stops sending
 * sessions and transactions, which Zentry drops anyway but which still cost a
 * Worker request each.
 */
export function rateLimited(seconds: number, cause: LimitCause, category = ""): Response {
  const wait = String(Math.max(1, Math.ceil(seconds)));

  return Response.json(
    { detail: "rate limited" },
    {
      status: 429,
      headers: {
        ...CORS_HEADERS,
        "Retry-After": wait,
        "X-Sentry-Rate-Limits": `${wait}:${category}:${cause.scope}:${cause.reason}`,
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
