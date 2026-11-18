// The read API: /api/0/*. Authenticates with Cloudflare Access, resolves the
// organization in the path, checks membership, then dispatches.

import type { Membership, UserRecord } from "@/db/tenancy";
import type { ApiMe } from "@/shared/contract";
import { MINUTE } from "@/shared/time";

import type { ApiDeps, Handler } from "./context";
import { getEvent, listEvents } from "./events";
import { badRequest, InvalidRequest, notFound, unauthorized } from "./http";
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
import {
  getIssueSubscription,
  getNotificationSettings,
  updateIssueSubscription,
  updateNotificationSetting,
} from "./notifications";
import { getLimits, updateLimits } from "./organization";
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

type Route = [method: string, pattern: RegExp, handler: Handler];

const ORG = String.raw`([\w-]+)`;
const ID = String.raw`(\d+)`;
const SLUG = String.raw`([\w-]+)`;

function route(method: string, path: string, handler: Handler): Route {
  return [method, new RegExp(`^/api/0${path}/?$`), handler];
}

// The first capture of every pattern is the organization slug.
const ROUTES: Route[] = [
  route("GET", `/organizations/${ORG}/projects`, listProjects),
  route("POST", `/organizations/${ORG}/projects`, createProject),
  route("GET", `/projects/${ORG}/${SLUG}`, getProject),
  route("PUT", `/projects/${ORG}/${SLUG}`, updateProject),
  route("DELETE", `/projects/${ORG}/${SLUG}`, deleteProject),
  route("GET", `/projects/${ORG}/${SLUG}/keys`, listKeys),
  route("POST", `/projects/${ORG}/${SLUG}/keys`, createKey),
  route("PUT", `/projects/${ORG}/${SLUG}/keys/${ID}`, updateKey),
  route("GET", `/organizations/${ORG}/limits`, getLimits),
  route("PUT", `/organizations/${ORG}/limits`, updateLimits),
  route("GET", `/organizations/${ORG}/notifications`, getNotificationSettings),
  route("PUT", `/organizations/${ORG}/notifications`, updateNotificationSetting),
  route("GET", `/organizations/${ORG}/issues`, listIssues),
  route("PUT", `/organizations/${ORG}/issues`, updateIssues),
  route("GET", `/organizations/${ORG}/issues/${ID}`, getIssue),
  route("PUT", `/organizations/${ORG}/issues/${ID}`, updateIssue),
  route("DELETE", `/organizations/${ORG}/issues/${ID}`, deleteIssue),
  route("GET", `/organizations/${ORG}/issues/${ID}/events`, listEvents),
  route("GET", `/organizations/${ORG}/issues/${ID}/events/([\\w-]+)`, getEvent),
  route("GET", `/organizations/${ORG}/issues/${ID}/tags`, getIssueTags),
  route("GET", `/organizations/${ORG}/issues/${ID}/stats`, getIssueStats),
  route("GET", `/organizations/${ORG}/issues/${ID}/activity`, getIssueActivity),
  route("GET", `/organizations/${ORG}/issues/${ID}/subscription`, getIssueSubscription),
  route("PUT", `/organizations/${ORG}/issues/${ID}/subscription`, updateIssueSubscription),
  route("GET", `/organizations/${ORG}/shortids/([\\w-]+)`, getShortId),
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

function me(session: Session): Response {
  return Response.json({
    id: session.user.id,
    email: session.user.email,
    organizations: session.memberships.map(({ id, slug, name }) => ({ id, slug, name })),
  } satisfies ApiMe);
}

type Matched = { handler: Handler; organization: string; args: string[] };

function match(method: string, pathname: string): Matched | null {
  for (const [routeMethod, pattern, handler] of ROUTES) {
    const [, organization, ...args] =
      (routeMethod === method ? pattern.exec(pathname) : null) ?? [];

    if (organization !== undefined) {
      return { handler, organization, args };
    }
  }

  return null;
}

export async function handleApi(
  request: Request,
  deps: ApiDeps,
  sessions: Sessions,
): Promise<Response> {
  const url = new URL(request.url);
  const email = await deps.access.email(request, deps.now());
  const session = email === null ? null : await sessions.resolve(email, deps);

  if (session === null) {
    return unauthorized();
  }

  if (request.method === "GET" && /^\/api\/0\/me\/?$/.test(url.pathname)) {
    return me(session);
  }

  const matched = match(request.method, url.pathname);
  const membership = session.memberships.find((entry) => entry.slug === matched?.organization);

  if (matched === null || membership === undefined) {
    return notFound();
  }

  const context = {
    request,
    url,
    deps,
    user: session.user,
    organizationId: membership.id,
    role: membership.role,
    now: deps.now(),
  };

  try {
    return await matched.handler(context, matched.args);
  } catch (cause) {
    // Only input that failed its schema is the client's fault; anything else
    // is ours and must surface as a 500.
    if (cause instanceof InvalidRequest) {
      return badRequest(cause.message);
    }

    throw cause;
  }
}
