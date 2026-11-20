// The ingest endpoints: POST /api/:project_id/envelope/ and /store/.
// DESIGN.md §5. The only processing done here is what is needed to accept or
// refuse the event; everything else happens in the queue consumer.

import { z } from "zod";

import { findEventItem, parseEnvelope } from "@/core/envelope";
import type { KeyInfo } from "@/db/keys";
import { newEventId, normalizeEventId, parseId } from "@/shared/ids";
import { jsonText } from "@/shared/json";
import { errorText, logError, logInfo } from "@/shared/log";
import type { MonitorCheckIn } from "@/shared/monitors";
import { Label, lenient } from "@/shared/schema";
import { nextMonthBucket, SECOND } from "@/shared/time";
import { INLINE_PAYLOAD_MAX_BYTES, MAX_ENVELOPE_BYTES, MAX_EVENT_BYTES } from "@/shared/types";
import type { QueueMessage } from "@/shared/types";

import { publicKeyOf, requestKey } from "./auth";
import type { KeyCache } from "./auth";
import { readBody } from "./body";
import { acceptCheckIn } from "./check-ins";
import { accepted, acceptedNothing, preflight, rateLimited, rejected, unavailable } from "./http";
import type { UsageCache } from "./limits";

export type IngestDeps = {
  keys: KeyCache;
  usage: UsageCache;
  /** Burst limiter; resolves to false when the key is over its limit. */
  allow: (publicKey: string) => Promise<boolean>;
  /** Stores an oversize payload and returns its key. */
  spill: (projectId: number, eventId: string, payload: string) => Promise<string>;
  /** Keyed by project, monitor slug and environment, as Sentry limits check-ins. */
  allowCheckIn: (key: string) => Promise<boolean>;
  recordCheckIn: (projectId: number, checkIn: MonitorCheckIn, now: number) => Promise<void>;
  send: (message: QueueMessage) => Promise<void>;
  now: () => number;
};

type Route = { projectId: number; kind: "envelope" | "store" };

/** What the request body held, before authentication. */
type Parsed = {
  payload: string | null;
  /** Size of the event as sent, before decoding. */
  checkIns: Uint8Array[];
  eventBytes: number;
  envelopeKey: string | null;
  envelopeEventId: string | null;
  sentAt: string | null;
};

/**
 * The only parts of the event ingest reads. The rest is validated by the
 * consumer (core/wire.ts), off the request path.
 */
const EventHead = jsonText(
  z.object({
    event_id: lenient(Label.transform(normalizeEventId)),
    type: lenient(Label),
  }),
);

type EventHead = z.output<typeof EventHead>;

const ROUTE = /^\/api\/(\d+)\/(envelope|store)\/?$/;
const decoder = new TextDecoder();
const encoder = new TextEncoder();

export function matchIngestRoute(url: URL): Route | null {
  const match = ROUTE.exec(url.pathname);
  const projectId = parseId(match?.[1] ?? "");
  const kind = match?.[2] === "store" ? "store" : "envelope";

  return match === null || projectId === null ? null : { projectId, kind };
}

function parseBody(bytes: Uint8Array, kind: Route["kind"]): Parsed | null {
  if (kind === "store") {
    return {
      payload: decoder.decode(bytes),
      checkIns: [],
      eventBytes: bytes.length,
      envelopeKey: null,
      envelopeEventId: null,
      sentAt: null,
    };
  }

  const envelope = parseEnvelope(bytes);

  if (envelope === null) {
    return null;
  }

  const item = findEventItem(envelope);

  return {
    payload: item === null ? null : decoder.decode(item.payload),
    checkIns: envelope.items
      .filter(({ header }) => header.type === "check_in")
      .map(({ payload }) => payload),
    eventBytes: item?.payload.length ?? 0,
    envelopeKey: envelope.header.publicKey,
    envelopeEventId: envelope.header.eventId,
    sentAt: envelope.header.sentAt,
  };
}

async function authenticate(
  request: Request,
  parsed: Parsed,
  deps: IngestDeps,
): Promise<{ publicKey: string; info: KeyInfo } | null> {
  const claimed = requestKey(request) ?? parsed.envelopeKey;
  const publicKey = claimed === null ? null : publicKeyOf(claimed);
  const info = publicKey === null ? null : await deps.keys.find(publicKey, deps.now());

  return publicKey === null || info === null ? null : { publicKey, info };
}

function resolveEventId(head: EventHead, parsed: Parsed): string {
  return head.event_id ?? parsed.envelopeEventId ?? newEventId();
}

type Accepted = {
  request: Request;
  parsed: Parsed;
  info: KeyInfo;
  publicKey: string;
  payload: string;
};

async function enqueue(input: Accepted, deps: IngestDeps): Promise<Response> {
  if (input.parsed.eventBytes > MAX_EVENT_BYTES) {
    return rejected(413, "event too large");
  }

  const parsedHead = EventHead.safeParse(input.payload);

  if (!parsedHead.success) {
    return rejected(400, "event is not a JSON object");
  }

  const head = parsedHead.data;

  if (head.type === "transaction") {
    return acceptedNothing();
  }

  // Only events count against the burst limit. Transactions, sessions and
  // other dropped items must not make the SDK back off from sending errors.
  if (!(await deps.allow(input.publicKey))) {
    return rateLimited(60, { scope: "key", reason: "key_quota" });
  }

  const eventId = resolveEventId(head, input.parsed);
  const { projectId } = input.info;
  // Measured as the queue will carry it: a JSON string, with its quotes escaped.
  const inline = encoder.encode(JSON.stringify(input.payload)).length <= INLINE_PAYLOAD_MAX_BYTES;

  const message: QueueMessage = {
    v: 1,
    project_id: projectId,
    key_id: input.info.keyId,
    event_id: eventId,
    received_at: deps.now(),
    client_ip: input.request.headers.get("cf-connecting-ip"),
    user_agent: input.request.headers.get("user-agent"),
    sent_at: input.parsed.sentAt,
    payload: inline ? input.payload : null,
    spill_key: inline ? null : await deps.spill(projectId, eventId, input.payload),
  };

  await deps.send(message);

  return accepted(eventId);
}

/**
 * The monthly cap first, as the broadest limit, then the project's hourly
 * limit. Both apply to every envelope, not only to events, so a limited SDK
 * backs off from everything it sends.
 */
async function limitedFor(info: KeyInfo, deps: IngestDeps): Promise<Response | null> {
  const now = deps.now();

  if ((await deps.usage.received(info.organizationId, now)) >= info.maxEventsPerMonth) {
    return rateLimited((nextMonthBucket(now) - now) / SECOND, {
      scope: "organization",
      reason: "org_quota",
    });
  }

  const { rateLimit } = info;

  return rateLimit !== null && rateLimit.until > now
    ? rateLimited((rateLimit.until - now) / SECOND, { scope: "project", reason: rateLimit.reason })
    : null;
}

async function receiveCheckIn(
  parsed: Parsed,
  auth: NonNullable<Awaited<ReturnType<typeof authenticate>>>,
  deps: IngestDeps,
): Promise<Response | undefined> {
  if (parsed.checkIns.length > 1) {
    return rejected(400, "one check-in per envelope");
  }

  const [checkIn] = parsed.checkIns;

  if (checkIn === undefined) {
    return undefined;
  }

  return acceptCheckIn(
    { bytes: checkIn, projectId: auth.info.projectId, publicKey: auth.publicKey },
    deps,
  );
}

async function accept(request: Request, route: Route, deps: IngestDeps): Promise<Response> {
  const body = await readBody(
    request,
    route.kind === "store" ? MAX_EVENT_BYTES : MAX_ENVELOPE_BYTES,
  );

  if (!("bytes" in body)) {
    return rejected(body.status, body.detail);
  }

  const parsed = parseBody(body.bytes, route.kind);

  if (parsed === null) {
    return rejected(400, "malformed envelope");
  }

  const auth = await authenticate(request, parsed, deps);

  if (auth === null || auth.info.projectId !== route.projectId) {
    return rejected(401, "invalid sentry key");
  }

  return receiveItems({ request, parsed, auth }, deps);
}

type EnvelopeInput = {
  request: Request;
  parsed: Parsed;
  auth: NonNullable<Awaited<ReturnType<typeof authenticate>>>;
};

async function receiveItems(input: EnvelopeInput, deps: IngestDeps): Promise<Response> {
  const { parsed, auth } = input;

  if (parsed.payload === null && parsed.checkIns.length > 0) {
    return (await receiveCheckIn(parsed, auth, deps)) ?? acceptedNothing();
  }

  const [event, checkIn] = await Promise.all([
    receiveEvent(input, deps),
    receiveCheckIn(parsed, auth, deps),
  ]);

  if (checkIn !== undefined) {
    logInfo("check-in rejected in mixed envelope", {
      project_id: auth.info.projectId,
      status: checkIn.status,
    });
    const limit = checkIn.headers.get("x-sentry-rate-limits");

    // Appended, not set: a 200 already limits the categories Zentry drops,
    // and the header takes comma-separated limits.
    if (limit !== null && event.ok) {
      event.headers.append("X-Sentry-Rate-Limits", limit);
    }
  }

  return event;
}

async function receiveEvent(input: EnvelopeInput, deps: IngestDeps): Promise<Response> {
  const { request, parsed, auth } = input;
  const limited = await limitedFor(auth.info, deps);

  if (limited !== null) {
    return limited;
  }

  return parsed.payload === null
    ? acceptedNothing()
    : enqueue({ request, parsed, ...auth, payload: parsed.payload }, deps);
}

export async function handleIngest(
  request: Request,
  route: Route,
  deps: IngestDeps,
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return preflight();
  }

  if (request.method !== "POST") {
    return rejected(405, "method not allowed");
  }

  // Anything that throws past here is our storage failing, not the request: the
  // queue send, the R2 spill, or the D1 reads behind the key and usage caches.
  // It is logged so the failure is seen, and answered with a 503 carrying CORS
  // headers, because a bare runtime error has none and a browser SDK could not
  // read it, let alone retry it.
  try {
    return await accept(request, route, deps);
  } catch (cause) {
    logError("ingest failed", { project_id: route.projectId, error: errorText(cause) });

    return unavailable();
  }
}
