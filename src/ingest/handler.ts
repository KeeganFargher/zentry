// The ingest endpoints: POST /api/:project_id/envelope/ and /store/.
// DESIGN.md §5. The only processing done here is what is needed to accept or
// refuse the event; everything else happens in the queue consumer.

import { envelopePublicKey, findEventItem, parseEnvelope } from "@/core/envelope";
import type { KeyInfo } from "@/db/keys";
import type { JsonObject } from "@/shared/contract";
import { newEventId, normalizeEventId, parseId } from "@/shared/ids";
import { asObject, getNonEmpty, parseJson } from "@/shared/json";
import { SECOND } from "@/shared/time";
import { INLINE_PAYLOAD_MAX_BYTES, MAX_ENVELOPE_BYTES, MAX_EVENT_BYTES } from "@/shared/types";
import type { QueueMessage } from "@/shared/types";

import { requestPublicKey } from "./auth";
import type { KeyCache } from "./auth";
import { readBody } from "./body";
import { accepted, preflight, rateLimited, rejected, unavailable } from "./http";

export type IngestDeps = {
  keys: KeyCache;
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
    envelopeKey: envelopePublicKey(envelope),
    envelopeEventId: getNonEmpty(envelope.header, "event_id"),
    sentAt: getNonEmpty(envelope.header, "sent_at"),
  };
}

async function authenticate(
  request: Request,
  parsed: Parsed,
  deps: IngestDeps,
): Promise<{ publicKey: string; info: KeyInfo } | null> {
  const publicKey = requestPublicKey(request, parsed.envelopeKey);
  const info = publicKey === null ? null : await deps.keys.find(publicKey, deps.now());

  return publicKey === null || info === null ? null : { publicKey, info };
}

function resolveEventId(event: JsonObject, parsed: Parsed): string {
  const claimed = getNonEmpty(event, "event_id") ?? parsed.envelopeEventId ?? "";

  return normalizeEventId(claimed) ?? newEventId();
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

  const event = asObject(parseJson(input.payload));

  if (event === null) {
    return rejected(400, "event is not a JSON object");
  }

  if (getNonEmpty(event, "type") === "transaction") {
    return accepted(null);
  }

  // Only events count against the burst limit. Transactions, sessions and
  // other dropped items must not make the SDK back off from sending errors.
  if (!(await deps.allow(input.publicKey))) {
    return rateLimited(60);
  }

  const eventId = resolveEventId(event, input.parsed);
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

  const limitedFor = (auth.info.rateLimitedUntil ?? 0) - deps.now();

  if (limitedFor > 0) {
    return rateLimited(limitedFor / SECOND);
  }

  return parsed.payload === null
    ? accepted(null)
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
