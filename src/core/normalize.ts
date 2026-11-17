// Turns a validated `WireEvent` into the `StoredEvent` we keep, plus the typed
// facts tags are built from. Pure: the receive time and client details are
// passed in.

import type { StoredEvent, StoredRequest, StoredSdk } from "@/shared/contract";

import {
  browserRequest,
  requestUserAgent,
  toStoredContexts,
  toStoredRequest,
  toStoredUser,
} from "./context";
import type { Origin } from "./context";
import { deriveCulprit, deriveTitle } from "./derive";
import { toStoredExceptions } from "./exceptions";
import { resolveTimestamp, toStoredBreadcrumbs, toStoredMessage, toStoredTags } from "./fields";
import { scrubObject } from "./scrub";
import type { TagFacts } from "./tags";
import { MAX_STRING, trimObject } from "./trim";
import { NO_AGENT, parseUserAgent } from "./useragent";
import type { Agent } from "./useragent";
import type { WireEvent, WireSdk } from "./wire";

export type EventMeta = {
  projectId: number;
  eventId: string;
  receivedAt: number;
  clientIp: string | null;
  userAgent: string | null;
  sentAt: string | null;
};

export type Normalized = { event: StoredEvent; facts: TagFacts };

const EXTRA_LIMITS = { depth: 5, maxKeys: 200, maxString: MAX_STRING };
const MAX_FINGERPRINT_PARTS = 20;

function toStoredSdk(raw: WireSdk): StoredSdk {
  return { name: raw.name, version: raw.version };
}

function originOf(raw: WireEvent, meta: EventMeta, platform: string): Origin {
  return {
    clientIp: meta.clientIp,
    userAgent: meta.userAgent,
    platform,
    // SDKs that were told not to collect IPs say so in `sdk.settings.infer_ip`.
    inferIp: raw.sdk?.settings?.infer_ip !== "never",
  };
}

type Client = { request: StoredRequest | null; agent: Agent };

/** The request, and what its User-Agent says about the client. */
function clientOf(raw: WireEvent, origin: Origin): Client {
  const request =
    raw.request === null ? browserRequest(origin) : toStoredRequest(raw.request, origin);

  const userAgent = request === null ? null : requestUserAgent(request);

  return { request, agent: userAgent === null ? NO_AGENT : parseUserAgent(userAgent) };
}

export function normalizeEvent(raw: WireEvent, meta: EventMeta): Normalized {
  const platform = raw.platform ?? "other";
  const origin = originOf(raw, meta, platform);
  const exceptions = toStoredExceptions(raw);
  const message = toStoredMessage(raw);
  const { request, agent } = clientOf(raw, origin);
  const { user, facts: userFacts } = toStoredUser(raw.user, origin);
  const { contexts, facts: contextFacts } = toStoredContexts(raw.contexts, agent);
  const fingerprint = raw.fingerprint.slice(0, MAX_FINGERPRINT_PARTS);

  const event: StoredEvent = {
    eventId: meta.eventId,
    projectId: meta.projectId,
    timestamp: raw.timestamp === null ? meta.receivedAt : resolveTimestamp(raw.timestamp, meta),
    receivedAt: meta.receivedAt,
    level: raw.level,
    platform,
    title: deriveTitle(exceptions, message?.formatted ?? ""),
    culprit: deriveCulprit(exceptions, raw.transaction ?? ""),
    message,
    exceptions,
    breadcrumbs: toStoredBreadcrumbs(raw.breadcrumbs),
    tags: toStoredTags(raw.tags),
    user,
    request,
    contexts,
    extra: scrubObject(trimObject(raw.extra, EXTRA_LIMITS)),
    sdk: raw.sdk === null ? null : toStoredSdk(raw.sdk),
    release: raw.release,
    environment: raw.environment ?? "production",
    serverName: raw.server_name,
    logger: raw.logger,
    transaction: raw.transaction,
    fingerprint: fingerprint.length === 0 ? null : fingerprint,
  };

  return { event, facts: { ...contextFacts, user: userFacts } };
}
