// The ingest endpoints: POST /api/:project_id/envelope/ and /store/.
// DESIGN.md §5. The only processing done here is what is needed to accept or
// refuse the event; everything else happens in the queue consumer.

import { z } from "zod";

import { findEventItem, parseEnvelope } from "@/core/envelope";
import type { KeyInfo } from "@/db/keys";
import { newEventId, normalizeEventId, parseId } from "@/shared/ids";
import { jsonText } from "@/shared/json";
import { Label, lenient } from "@/shared/schema";
import { nextMonthBucket, SECOND } from "@/shared/time";
import { INLINE_PAYLOAD_MAX_BYTES, MAX_ENVELOPE_BYTES, MAX_EVENT_BYTES } from "@/shared/types";
import type { QueueMessage } from "@/shared/types";

import { publicKeyOf, requestKey } from "./auth";
import type { KeyCache } from "./auth";
import { readBody } from "./body";
import { accepted, acceptedNothing, preflight, rateLimited, rejected, unavailable } from "./http";
import type { UsageCache } from "./limits";

export type IngestDeps = {
  keys: KeyCache;
  usage: UsageCache;
  /** Events accepted per UTC month, all projects together, before ingest refuses all. */
  maxEventsPerMonth: number;
  /** Burst limiter; resolves to false when the key is over its limit. */
  allow: (publicKey: string) => Promise<boolean>;
  /** Stores an oversize payload and returns its key. */
  spill: (projectId: number, eventId: string, payload: string) => Promise<string>;
  send: (message: QueueMessage) => Promise<void>;
  now: () => number;
};

type Route = { projectId: number; kind: "envelope" | "store" };

/** What the request body held, before authentication. */
type Parsed = {
  payload: string | null;
  /** Size of the event as sent, before decoding. */
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

  try {
    await deps.send(message);
  } catch {
    return unavailable();
  }

  return accepted(eventId);
}

/**
 * The monthly cap first, as the broadest limit, then the project's hourly
 * limit. Both apply to every envelope, not only to events, so a limited SDK
 * backs off from everything it sends.
 */
async function limitedFor(info: KeyInfo, deps: IngestDeps): Promise<Response | null> {
  const now = deps.now();

  if ((await deps.usage.received(now)) >= deps.maxEventsPerMonth) {
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

  return request.method === "POST"
    ? accept(request, route, deps)
    : rejected(405, "method not allowed");
}
