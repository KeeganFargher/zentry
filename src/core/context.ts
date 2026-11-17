// Normalization of the request, user and contexts interfaces, plus the typed
// facts that tags are built from.

import type { JsonObject, Pair, StoredRequest } from "@/shared/contract";

import { scrubBody, scrubObject, scrubPairs, scrubQueryString, scrubText } from "./scrub";
import type { ContextFacts, UserFacts } from "./tags";
import { cut, MAX_STRING, trimJson, trimObject } from "./trim";
import type { Agent, AgentPart } from "./useragent";
import type { WireContexts, WireRequest, WireUser } from "./wire";

/** Where the event came from, as seen by the ingest Worker. */
export type Origin = {
  clientIp: string | null;
  userAgent: string | null;
  platform: string;
  /** False when the SDK set `sdk.settings.infer_ip` to "never". */
  inferIp: boolean;
};

type ContextName = "browser" | "os" | "runtime" | "device";

export type StoredContexts = {
  contexts: JsonObject;
  facts: Record<ContextName, ContextFacts | null>;
};

const AUTO_IP = "{{auto}}";
const USER_LIMITS = { depth: 3, maxKeys: 50, maxString: 1024 };
const DATA_LIMITS = { depth: 5, maxKeys: 200, maxString: MAX_STRING };

function isBrowser(origin: Origin): boolean {
  return origin.platform === "javascript";
}

function findHeader(headers: Pair[], name: string): string | null {
  return headers.find(([key]) => key.toLowerCase() === name)?.[1] ?? null;
}

/** Browser SDKs leave the User-Agent to the browser, so it is taken from the request. */
function toStoredHeaders(sent: Pair[], origin: Origin): Pair[] {
  const headers = sent.map(([key, value]): Pair => [key, cut(value, 2048)]);

  if (
    isBrowser(origin) &&
    origin.userAgent !== null &&
    findHeader(headers, "user-agent") === null
  ) {
    headers.push(["User-Agent", origin.userAgent]);
  }

  return scrubPairs(headers);
}

/**
 * The request of an event that sent none. A browser event still gets one, so
 * the User-Agent the browser sent is kept for the browser and OS tags.
 */
export function browserRequest(origin: Origin): StoredRequest | null {
  const headers = toStoredHeaders([], origin);

  return headers.length === 0
    ? null
    : { url: null, method: null, queryString: null, headers, data: null };
}

export function toStoredRequest(raw: WireRequest, origin: Origin): StoredRequest {
  const [path = "", urlQuery = null] = raw.url === null ? [] : raw.url.split("?", 2);
  const query = raw.query_string ?? urlQuery;

  return {
    // The path can carry `user:pass@` credentials, so it gets the text scrub.
    url: path === "" ? null : scrubText(cut(path, MAX_STRING)),
    method: raw.method,
    queryString: query === null ? null : scrubQueryString(cut(query, MAX_STRING)),
    headers: toStoredHeaders(raw.headers, origin),
    data: scrubBody(trimJson(raw.data, DATA_LIMITS)),
  };
}

/** The client's address, unless the SDK said not to collect it. */
function autoIp(origin: Origin): string | null {
  return origin.inferIp ? origin.clientIp : null;
}

/** An address the SDK sent is kept, except `{{auto}}`, which asks for the client's. */
function sentIp(claimed: string, origin: Origin): string | null {
  return claimed === AUTO_IP ? autoIp(origin) : claimed;
}

/** A browser SDK never knows its own address, so sending none means "use the client's". */
function unsentIp(origin: Origin): string | null {
  return isBrowser(origin) ? autoIp(origin) : null;
}

export type StoredUser = { user: JsonObject | null; facts: UserFacts };

export function toStoredUser(raw: WireUser, origin: Origin): StoredUser {
  const user = trimObject(raw.fields, USER_LIMITS);
  const resolved = raw.ip_address === null ? unsentIp(origin) : sentIp(raw.ip_address, origin);
  const ip = resolved === null ? null : cut(resolved, USER_LIMITS.maxString);

  // The SDK's value was only a request; the resolved one replaces it.
  delete user["ip_address"];

  if (ip !== null) {
    user["ip_address"] = ip;
  }

  return {
    user: Object.keys(user).length === 0 ? null : scrubObject(user),
    facts: {
      id: raw.id,
      email: raw.email,
      username: raw.username,
      ipAddress: ip === "" ? null : ip,
    },
  };
}

function describe(part: AgentPart): JsonObject {
  return { name: part.name, version: part.version };
}

function agentFacts(part: AgentPart): ContextFacts {
  return { name: part.name, version: part.version, model: null, family: null };
}

/** Fills `browser` and `os` from the User-Agent when the SDK sent neither. */
export function toStoredContexts(raw: WireContexts, agent: Agent): StoredContexts {
  const contexts = scrubObject(trimObject(raw.all, DATA_LIMITS));
  const { browser, os, runtime, device } = raw;

  if (browser === null && agent.browser !== null) {
    contexts["browser"] = describe(agent.browser);
  }

  if (os === null && agent.os !== null) {
    contexts["os"] = describe(agent.os);
  }

  return {
    contexts,
    facts: {
      browser: browser ?? (agent.browser === null ? null : agentFacts(agent.browser)),
      os: os ?? (agent.os === null ? null : agentFacts(agent.os)),
      runtime,
      device,
    },
  };
}

export function requestUserAgent(request: StoredRequest): string | null {
  return findHeader(request.headers, "user-agent");
}
