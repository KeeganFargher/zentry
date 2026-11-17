// Normalization of the request, user and contexts interfaces.

import type { JsonObject, Pair, StoredRequest } from "@/shared/contract";
import { getNonEmpty, getObject, getString } from "@/shared/json";

import { parsePairs } from "./fields";
import { scrubBody, scrubObject, scrubPairs, scrubQueryString } from "./scrub";
import { cut, cutOrNull, MAX_STRING, trimJson, trimObject } from "./trim";
import { parseUserAgent } from "./useragent";

/** Where the event came from, as seen by the ingest Worker. */
export type Origin = {
  clientIp: string | null;
  userAgent: string | null;
  platform: string;
  /** False when the SDK set `sdk.settings.infer_ip` to "never". */
  inferIp: boolean;
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

function parseHeaders(raw: JsonObject, origin: Origin): Pair[] {
  const headers = parsePairs(raw["headers"]).map(([key, value]): Pair => [key, cut(value, 2048)]);

  if (
    isBrowser(origin) &&
    origin.userAgent !== null &&
    findHeader(headers, "user-agent") === null
  ) {
    headers.push(["User-Agent", origin.userAgent]);
  }

  return scrubPairs(headers);
}

function parseQuery(raw: JsonObject, urlQuery: string | null): string | null {
  const text = getNonEmpty(raw, "query_string");
  const pairs = parsePairs(raw["query_string"]);
  const joined = pairs.map(([key, value]) => `${key}=${value}`).join("&");
  const query = text ?? (joined === "" ? urlQuery : joined);

  return query === null ? null : scrubQueryString(cut(query, MAX_STRING));
}

export function parseRequest(raw: JsonObject | null, origin: Origin): StoredRequest | null {
  const source = raw ?? {};
  const headers = parseHeaders(source, origin);
  const [path, urlQuery = null] = (getNonEmpty(source, "url") ?? "").split("?", 2);

  if (raw === null && headers.length === 0) {
    return null;
  }

  return {
    url: path === undefined || path === "" ? null : cut(path, MAX_STRING),
    method: cutOrNull(getNonEmpty(source, "method"), 20),
    queryString: parseQuery(source, urlQuery),
    headers,
    data: scrubBody(trimJson(source["data"] ?? null, DATA_LIMITS)),
  };
}

function resolveIp(claimed: string | null, origin: Origin): string | null {
  const wantsAuto = claimed === AUTO_IP || (claimed === null && isBrowser(origin));

  if (!wantsAuto) {
    return claimed;
  }

  return origin.inferIp ? origin.clientIp : null;
}

export function parseUser(raw: JsonObject | null, origin: Origin): JsonObject | null {
  const user = raw === null ? {} : trimObject(raw, USER_LIMITS);
  const ip = resolveIp(getString(user, "ip_address"), origin);

  if (ip === null) {
    delete user["ip_address"];
  } else {
    user["ip_address"] = ip;
  }

  return Object.keys(user).length === 0 ? null : scrubObject(user);
}

function describe(name: string, version: string | null): JsonObject {
  const described: JsonObject = {};

  described["name"] = name;
  described["version"] = version;

  return described;
}

/** Fills `browser` and `os` from the User-Agent when the SDK sent neither. */
export function parseContexts(raw: JsonObject | null, userAgent: string | null): JsonObject {
  const contexts = raw === null ? {} : scrubObject(trimObject(raw, DATA_LIMITS));
  const agent = parseUserAgent(userAgent ?? "");

  if (getObject(contexts, "browser") === null && agent.browser !== null) {
    contexts["browser"] = describe(agent.browser.name, agent.browser.version);
  }

  if (getObject(contexts, "os") === null && agent.os !== null) {
    contexts["os"] = describe(agent.os.name, agent.os.version);
  }

  return contexts;
}

export function requestUserAgent(request: StoredRequest | null): string | null {
  return request === null ? null : findHeader(request.headers, "user-agent");
}
