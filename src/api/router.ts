// The read API: /api/0/*. Works out who is calling (Cloudflare Access, a
// mobile app's device token, or a sentry-cli token), resolves the
// organization in the path, checks membership, then dispatches.

import type { CliCaller } from "@/db/cli-tokens";
import type { DeviceRecord } from "@/db/devices";
import type { Membership, UserRecord } from "@/db/tenancy";
import type { ApiMe } from "@/shared/contract";
import { CLI_TOKEN_PREFIX, sha256Hex } from "@/shared/ids";
import { errorText, logError } from "@/shared/log";
import { DAY, MINUTE } from "@/shared/time";

import { cliCaller, dispatchCli } from "./cli-router";
import { createCliToken, listCliTokens, revokeCliToken } from "./cli-tokens";
import type { ApiDeps, Handler, UserContext, UserHandler } from "./context";
import {
  createPairing,
  listDevices,
  redeemPairing,
  removeDevice,
  updatePushToken,
} from "./devices";
import { getEvent, listEvents } from "./events";
import { badRequest, forbidden, InvalidRequest, notFound, unauthorized } from "./http";
import {
  deleteIssue,
  getIssue,
  getIssueActivity,
  getIssueStats,
  getIssueTags,
  getShortId,
  listIssues,
  updateIssue,
  updateIssues,
} from "./issues";
import { getMonitorPreview, previewMonitor } from "./monitor-previews";
import {
  createMonitorRule,
  listMonitorMembers,
  listMonitorRules,
  updateMonitorRule,
} from "./monitor-rules";
import { monitorTimeline } from "./monitor-timeline";
import {
  createMonitor,
  editMonitor,
  getMonitor,
  listMonitors,
  monitorHistory,
  muteMonitor,
  setMonitorStatus,
  unrecognizedCheckIns,
} from "./monitors";
import {
  getIssueSubscription,
  getNotificationSettings,
  updateIssueSubscription,
  updateNotificationSetting,
} from "./notifications";
import { getLimits, updateLimits } from "./organization";
import { apiPattern, ID, ORG, SLUG } from "./paths";
import {
  createKey,
  createProject,
  deleteProject,
  getProject,
  listKeys,
  listProjects,
  updateKey,
  updateProject,
} from "./projects";

/**
 * Who may call a route. A device token is a long-lived secret on a phone, on
 * a host Access does not guard, so it reaches only what the app needs:
 * reading and triaging issues, following them, notification settings,
 * reading monitors (never changing them), and its own sign-out. Everything
 * else stays behind Access, and a new route is web-only until it is marked
 * app() (DESIGN.md §19.1). sentry-cli tokens never reach this table: they
 * have their own, in cli-router.ts (§20).
 */
type Reach = "web" | "any";

type Route<H> = { method: string; pattern: RegExp; handler: H; reach: Reach };

/** A route for the web UI only. Closed to device tokens unless marked with app(). */
function route<H>(method: string, path: string, handler: H): Route<H> {
  return { method, pattern: apiPattern(path), handler, reach: "web" };
}

/** Opens a route to the mobile app's device tokens too: a decision made route by route. */
function app<H>(closed: Route<H>): Route<H> {
  return { ...closed, reach: "any" };
}

// The first capture of every pattern is the organization slug.
const ROUTES: Route<Handler>[] = [
  app(route("GET", `/organizations/${ORG}/projects`, listProjects)),
  route("POST", `/organizations/${ORG}/projects`, createProject),
  route("POST", `/organizations/${ORG}/monitors`, createMonitor),
  route("GET", `/organizations/${ORG}/monitor-members`, listMonitorMembers),
  route("GET", `/organizations/${ORG}/monitor-alert-rules`, listMonitorRules),
  route("POST", `/organizations/${ORG}/monitor-alert-rules`, createMonitorRule),
  route("PUT", `/organizations/${ORG}/monitor-alert-rules/([0-9a-f-]+)`, updateMonitorRule),
  route("POST", `/organizations/${ORG}/monitor-previews`, previewMonitor),
  route("GET", `/organizations/${ORG}/monitor-previews/([0-9a-f-]+)`, getMonitorPreview),
  // The app reads monitors; it never changes them.
  app(route("GET", `/organizations/${ORG}/monitors`, listMonitors)),
  route("GET", `/organizations/${ORG}/monitors/unrecognized-check-ins`, unrecognizedCheckIns),
  app(route("GET", `/organizations/${ORG}/monitors/([0-9a-f-]+)`, getMonitor)),
  route("PUT", `/organizations/${ORG}/monitors/([0-9a-f-]+)`, editMonitor),
  route("PUT", `/organizations/${ORG}/monitors/([0-9a-f-]+)/status`, setMonitorStatus),
  route("PUT", `/organizations/${ORG}/monitors/([0-9a-f-]+)/mute`, muteMonitor),
  route("GET", `/organizations/${ORG}/monitors/([0-9a-f-]+)/observations`, monitorHistory),
  app(route("GET", `/organizations/${ORG}/monitors/([0-9a-f-]+)/timeline`, monitorTimeline)),
  app(route("GET", `/projects/${ORG}/${SLUG}`, getProject)),
  route("PUT", `/projects/${ORG}/${SLUG}`, updateProject),
  route("DELETE", `/projects/${ORG}/${SLUG}`, deleteProject),
  route("GET", `/projects/${ORG}/${SLUG}/keys`, listKeys),
  route("POST", `/projects/${ORG}/${SLUG}/keys`, createKey),
  route("PUT", `/projects/${ORG}/${SLUG}/keys/${ID}`, updateKey),
  route("GET", `/organizations/${ORG}/limits`, getLimits),
  route("PUT", `/organizations/${ORG}/limits`, updateLimits),
  app(route("GET", `/organizations/${ORG}/notifications`, getNotificationSettings)),
  app(route("PUT", `/organizations/${ORG}/notifications`, updateNotificationSetting)),
  app(route("GET", `/organizations/${ORG}/issues`, listIssues)),
  app(route("PUT", `/organizations/${ORG}/issues`, updateIssues)),
  app(route("GET", `/organizations/${ORG}/issues/${ID}`, getIssue)),
  app(route("PUT", `/organizations/${ORG}/issues/${ID}`, updateIssue)),
  route("DELETE", `/organizations/${ORG}/issues/${ID}`, deleteIssue),
  app(route("GET", `/organizations/${ORG}/issues/${ID}/events`, listEvents)),
  app(route("GET", `/organizations/${ORG}/issues/${ID}/events/([\\w-]+)`, getEvent)),
  app(route("GET", `/organizations/${ORG}/issues/${ID}/tags`, getIssueTags)),
  app(route("GET", `/organizations/${ORG}/issues/${ID}/stats`, getIssueStats)),
  app(route("GET", `/organizations/${ORG}/issues/${ID}/activity`, getIssueActivity)),
  app(route("GET", `/organizations/${ORG}/issues/${ID}/subscription`, getIssueSubscription)),
  app(route("PUT", `/organizations/${ORG}/issues/${ID}/subscription`, updateIssueSubscription)),
  app(route("GET", `/organizations/${ORG}/shortids/([\\w-]+)`, getShortId)),
  route("GET", `/organizations/${ORG}/cli-tokens`, listCliTokens),
  route("POST", `/organizations/${ORG}/cli-tokens`, createCliToken),
  route("DELETE", `/organizations/${ORG}/cli-tokens/${ID}`, revokeCliToken),
];

/** Routes about the caller, outside any organization. */
const USER_ROUTES: Route<UserHandler>[] = [
  app(route("GET", "/me", me)),
  route("POST", "/me/pairings", createPairing),
  app(route("GET", "/me/devices", listDevices)),
  app(route("DELETE", `/me/devices/${ID}`, removeDevice)),
  app(route("PUT", "/me/device", updatePushToken)),
];

type Session = { user: UserRecord; memberships: Membership[]; expiresAt: number };

const SESSION_TTL = 5 * MINUTE;

/** Caches the user row and memberships per isolate, to avoid a write per request. */
export class Sessions {
  readonly #sessions = new Map<string, Session>();

  async resolve(email: string, deps: ApiDeps): Promise<Session | null> {
    const now = deps.now();
    const cached = this.#sessions.get(email);

    if (cached !== undefined && cached.expiresAt > now) {
      return cached;
    }

    const user = await deps.tenancy.ensureUser(email, now);

    if (user === null) {
      return null;
    }

    const memberships = await deps.tenancy.memberships(user.id);
    const session = { user, memberships, expiresAt: now + SESSION_TTL };

    this.#sessions.set(email, session);

    return session;
  }
}

/** Someone signed in through Access, or a phone acting for its user. */
type Caller = { user: UserRecord; memberships: Membership[]; device: DeviceRecord | null };

/**
 * A sentry-cli token is its own kind of caller, never a Caller with no device:
 * `device === null` means "signed in through Access" to every check below, so
 * a token modelled that way would reach the whole web API.
 */
type Identified = { kind: "user"; caller: Caller } | { kind: "cli"; caller: CliCaller };

async function me(context: UserContext): Promise<Response> {
  const memberships = await context.deps.tenancy.memberships(context.user.id);

  return Response.json({
    id: context.user.id,
    email: context.user.email,
    organizations: memberships.map(({ id, slug, name }) => ({ id, slug, name })),
  } satisfies ApiMe);
}

const BEARER = /^Bearer (\S+)$/;

/**
 * A token unused this long stops working, and its device is signed out. A
 * phone in use renews it every hour it is used; one lost, or kept by someone
 * who has since lost their Access, does not keep its way in for ever.
 */
const DEVICE_IDLE_LIMIT = 30 * DAY;

/**
 * A device token is looked up on every request, never cached, so signing a
 * phone out takes effect at once. The user is read, never created: a device
 * exists only for a user who signed in through Access.
 */
async function deviceCaller(token: string, deps: ApiDeps): Promise<Caller | null> {
  const now = deps.now();
  const device = await deps.devices.byToken(await sha256Hex(token));
  const user = device === null ? null : await deps.tenancy.user(device.userId);

  if (device === null || user === null) {
    return null;
  }

  if (now - device.lastSeenAt > DEVICE_IDLE_LIMIT) {
    await deps.devices.remove(device.userId, device.id);

    return null;
  }

  await deps.devices.touch(device, now);

  return { user, memberships: await deps.tenancy.memberships(user.id), device };
}

async function bearerCaller(token: string, deps: ApiDeps): Promise<Identified | null> {
  if (token.startsWith(CLI_TOKEN_PREFIX)) {
    const caller = await cliCaller(token, deps);

    return caller === null ? null : { kind: "cli", caller };
  }

  const caller = await deviceCaller(token, deps);

  return caller === null ? null : { kind: "user", caller };
}

/**
 * An Authorization header always means a token (a CLI token by its prefix,
 * otherwise a device token), even on localhost, where the development email
 * would otherwise sign in anything: a bad token must fail there as it would
 * in production. On the ingest host, which Access does not guard, a token is
 * the only way in.
 */
async function identify(
  request: Request,
  deps: ApiDeps,
  sessions: Sessions,
): Promise<Identified | null> {
  const authorization = request.headers.get("authorization");

  if (authorization !== null) {
    const [, token] = BEARER.exec(authorization) ?? [];

    return token === undefined ? null : bearerCaller(token, deps);
  }

  if (new URL(request.url).hostname === deps.ingestHost) {
    return null;
  }

  const email = await deps.access.email(request, deps.now());
  const session = email === null ? null : await sessions.resolve(email, deps);

  return session === null ? null : { kind: "user", caller: { ...session, device: null } };
}

type Matched<H> = { route: Route<H>; captures: string[] };

function match<H>(routes: Route<H>[], method: string, pathname: string): Matched<H> | null {
  for (const candidate of routes) {
    const captures = candidate.method === method ? candidate.pattern.exec(pathname) : null;

    if (captures !== null) {
      return { route: candidate, captures: captures.slice(1) };
    }
  }

  return null;
}

/** A device token on a web-only route is refused outright, not hidden as a 404. */
function reachable(reach: Reach, caller: Caller): boolean {
  return reach === "any" || caller.device === null;
}

async function dispatch(request: Request, deps: ApiDeps, caller: Caller): Promise<Response> {
  const url = new URL(request.url);
  const base = { request, url, deps, user: caller.user, device: caller.device, now: deps.now() };
  const own = match(USER_ROUTES, request.method, url.pathname);

  if (own !== null) {
    return reachable(own.route.reach, caller)
      ? own.route.handler(base, own.captures)
      : forbidden("the mobile app cannot do this; use the web UI");
  }

  const matched = match(ROUTES, request.method, url.pathname);
  const [organization, ...args] = matched?.captures ?? [];
  const membership = caller.memberships.find((entry) => entry.slug === organization);

  if (matched === null || membership === undefined) {
    return notFound();
  }

  if (!reachable(matched.route.reach, caller)) {
    return forbidden("the mobile app cannot do this; use the web UI");
  }

  const context = {
    ...base,
    organizationId: membership.id,
    organizationSlug: membership.slug,
    role: membership.role,
  };

  return matched.route.handler(context, args);
}

const PAIR_PATH = /^\/api\/0\/pair\/?$/;

export async function handleApi(
  request: Request,
  deps: ApiDeps,
  sessions: Sessions,
): Promise<Response> {
  try {
    if (request.method === "POST" && PAIR_PATH.test(new URL(request.url).pathname)) {
      return await redeemPairing(request, deps);
    }

    const identified = await identify(request, deps, sessions);

    if (identified === null) {
      return unauthorized();
    }

    return identified.kind === "cli"
      ? await dispatchCli(request, deps, identified.caller)
      : await dispatch(request, deps, identified.caller);
  } catch (cause) {
    // Only input that failed its schema is the client's fault; anything else
    // is ours and must surface as a 500.
    if (cause instanceof InvalidRequest) {
      return badRequest(cause.message);
    }

    throw cause;
  }
}

export async function serveApi(
  request: Request,
  deps: ApiDeps,
  sessions: Sessions,
): Promise<Response> {
  try {
    return await handleApi(request, deps, sessions);
  } catch (cause) {
    logError("api request failed", { url: request.url, error: errorText(cause) });

    return Response.json({ detail: "internal error" }, { status: 500 });
  }
}

export async function serveAppApi(
  request: Request,
  limiter: RateLimit,
  serve: () => Promise<Response>,
): Promise<Response> {
  const client = request.headers.get("cf-connecting-ip");

  if (client === null) {
    throw new Error("request without cf-connecting-ip on the ingest host");
  }

  const { success } = await limiter.limit({ key: client });

  return success ? serve() : Response.json({ detail: "too many requests" }, { status: 429 });
}
