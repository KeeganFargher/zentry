// Turns the raw event JSON an SDK sent into the `StoredEvent` we keep.
// Pure: the receive time and client details are passed in.

import type { JsonObject, StoredEvent, StoredSdk } from "@/shared/contract";
import { getArray, getNonEmpty, getObject, stringsIn } from "@/shared/json";

import { parseContexts, parseRequest, parseUser, requestUserAgent } from "./context";
import type { Origin } from "./context";
import { deriveCulprit, deriveTitle } from "./derive";
import { parseEventExceptions } from "./exceptions";
import { parseBreadcrumbs, parseLevel, parseMessage, parseTags, resolveTimestamp } from "./fields";
import { scrubObject } from "./scrub";
import { cut, cutOrNull, MAX_STRING, trimObject } from "./trim";

export type EventMeta = {
  projectId: number;
  eventId: string;
  receivedAt: number;
  clientIp: string | null;
  userAgent: string | null;
  sentAt: string | null;
};

const EXTRA_LIMITS = { depth: 5, maxKeys: 200, maxString: MAX_STRING };
const MAX_FINGERPRINT_PARTS = 20;

function parseSdk(raw: JsonObject | null): StoredSdk | null {
  if (raw === null) {
    return null;
  }

  return {
    name: cutOrNull(getNonEmpty(raw, "name"), 200),
    version: cutOrNull(getNonEmpty(raw, "version"), 200),
  };
}

function parseFingerprint(raw: JsonObject): string[] | null {
  const parts = stringsIn(getArray(raw, "fingerprint")).slice(0, MAX_FINGERPRINT_PARTS);

  return parts.length === 0 ? null : parts.map((part) => cut(part, 500));
}

function parseExtra(raw: JsonObject): JsonObject {
  const extra = getObject(raw, "extra");

  return extra === null ? {} : scrubObject(trimObject(extra, EXTRA_LIMITS));
}

/** SDKs that were told not to collect IPs say so in `sdk.settings.infer_ip`. */
function infersIp(raw: JsonObject): boolean {
  const settings = getObject(getObject(raw, "sdk") ?? {}, "settings");

  return settings === null || getNonEmpty(settings, "infer_ip") !== "never";
}

function label(raw: JsonObject, key: string): string | null {
  return cutOrNull(getNonEmpty(raw, key), 200);
}

export function normalizeEvent(raw: JsonObject, meta: EventMeta): StoredEvent {
  const platform = label(raw, "platform") ?? "other";

  const origin: Origin = {
    clientIp: meta.clientIp,
    userAgent: meta.userAgent,
    platform,
    inferIp: infersIp(raw),
  };

  const exceptions = parseEventExceptions(raw);
  const message = parseMessage(raw);
  const request = parseRequest(getObject(raw, "request"), origin);
  const transaction = label(raw, "transaction");

  return {
    eventId: meta.eventId,
    projectId: meta.projectId,
    timestamp: resolveTimestamp(raw["timestamp"], meta),
    receivedAt: meta.receivedAt,
    level: parseLevel(raw["level"]),
    platform,
    title: deriveTitle(exceptions, message),
    culprit: deriveCulprit(exceptions, transaction),
    message,
    exceptions,
    breadcrumbs: parseBreadcrumbs(raw["breadcrumbs"]),
    tags: parseTags(raw["tags"]),
    user: parseUser(getObject(raw, "user"), origin),
    request,
    contexts: parseContexts(getObject(raw, "contexts"), requestUserAgent(request)),
    extra: parseExtra(raw),
    sdk: parseSdk(getObject(raw, "sdk")),
    release: label(raw, "release"),
    environment: label(raw, "environment") ?? "production",
    serverName: label(raw, "server_name"),
    logger: label(raw, "logger"),
    transaction,
    fingerprint: parseFingerprint(raw),
  };
}
