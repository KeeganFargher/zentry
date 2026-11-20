// The sentry-cli API (DESIGN.md §20): the few endpoints of Sentry's public API
// that the CLI's read and triage commands call, in Sentry's response shapes.
//
// These are not the web UI's endpoints with another serializer. The paths
// overlap (`/organizations/{org}/projects/` is both), but the CLI wants bare
// JSON arrays, string ids, ISO dates and `Link` header pagination, where the
// UI and the app want our own shapes. The router sends a token caller here
// and nowhere else, so neither side can break the other.
//
// Field lists follow sentry-cli's structs in src/api/mod.rs (Organization,
// Project, Issue, ProcessedEvent, Monitor, AuthInfo): every field the CLI
// does not mark optional is always present, or its deserializer fails.

import { z } from "zod";

import { NEWEST } from "@/db/events";
import type { EventCursor, ProjectEventRow } from "@/db/events";
import type { IssueCursor, IssueRecord } from "@/db/issues";
import type { ProjectRecord } from "@/db/projects";
import type { ApiMonitor } from "@/shared/monitors";

import { parseSearch, SentryStatus } from "./cli-search";
import type { CliContext, CliHandler } from "./context";
import { CursorParam, encodeCursor, IdParam, IntParam, InvalidRequest, notFound } from "./http";
import { readBody, readParams, readQuery } from "./http";
import { applyStatus } from "./issues";

/** sentry-cli's page sizes say "100 issues/page" and "100 events/page". */
const PAGE_SIZE = 100;

/**
 * Sentry's own cap on a bulk issue change with no ids (BULK_MUTATION_LIMIT in
 * src/sentry/api/helpers/group_index). Sentry quietly changes the first
 * thousand; we refuse instead, so `resolve --all` never reports success on a
 * project it only partly changed.
 */
const BULK_LIMIT = 1000;

/**
 * What a token may do, in Sentry's scope names, for `sentry-cli info`. These
 * describe the routes below, not a permission system: a token reaches every
 * one of them.
 */
const SCOPES = ["org:read", "project:read", "event:read", "event:write"];

const iso = (ms: number): string => new Date(ms).toISOString();

// ── Pagination ───────────────────────────────────────────────────────────────

/** Whether another page follows this one, and the cursor that fetches it. */
type Page = { more: true; cursor: string } | { more: false };

/**
 * One page, with Sentry's `Link` header. sentry-cli reads only `rel="next"`:
 * it follows `cursor` while `results` is "true" (src/api/pagination.rs).
 */
function paged(body: unknown[], url: URL, page: Page): Response {
  const cursor = page.more ? page.cursor : "";
  const next = new URL(url);

  next.searchParams.set("cursor", cursor);

  const link = `<${next.toString()}>; rel="next"; results="${String(page.more)}"; cursor="${cursor}"`;

  return Response.json(body, { headers: { link } });
}

/** Splits `rows` (fetched one past the page) into the page and what follows it. */
function pageOf<T>(rows: T[], cursorOf: (last: T) => string): { rows: T[]; page: Page } {
  const page = rows.slice(0, PAGE_SIZE);
  const last = page.at(-1);

  return rows.length > PAGE_SIZE && last !== undefined
    ? { rows: page, page: { more: true, cursor: cursorOf(last) } }
    : { rows: page, page: { more: false } };
}

// ── Lookups ──────────────────────────────────────────────────────────────────

async function projectOf(context: CliContext, args: string[]): Promise<ProjectRecord | null> {
  const [slug] = readParams(args, z.tuple([z.string()]));

  return context.deps.projects.findBySlug(context.caller.organization.id, slug);
}

// ── Auth and organization ────────────────────────────────────────────────────

/** `GET /api/0/`: what `sentry-cli info` and `login` check the token against. */
export const authInfo: CliHandler = async (context) => {
  const { user } = context.caller;

  return Response.json({
    user: { id: String(user.id), email: user.email },
    auth: { scopes: SCOPES },
  });
};

/** `GET /api/0/organizations/`: only the token's own organization. */
export const listOrganizations: CliHandler = async (context) => {
  const { organization } = context.caller;

  return Response.json([
    {
      id: String(organization.id),
      slug: organization.slug,
      name: organization.name,
      dateCreated: iso(organization.createdAt),
      isEarlyAdopter: false,
      require2FA: false,
    },
  ]);
};

/** Every project in one page: an organization has few, and our list is unpaginated. */
export const listProjects: CliHandler = async (context) => {
  const projects = await context.deps.projects.list(context.caller.organization.id);

  return Response.json(
    projects.map((project) => ({
      id: String(project.id),
      slug: project.slug,
      name: project.name,
      platform: project.platform,
      dateCreated: iso(project.createdAt),
      // Zentry has no teams.
      team: null,
    })),
  );
};

// ── Issues ───────────────────────────────────────────────────────────────────

// sentry-cli sends `cursor=` empty on the first page, which readQuery treats as absent.
const IssueListQuery = z.object({
  query: z.string().default(""),
  cursor: CursorParam.pipe(
    z.tuple([IntParam, IntParam]).transform(([value, id]): IssueCursor => ({ value, id })),
  )
    .nullable()
    .default(null),
});

function toSentryIssue(issue: IssueRecord) {
  return {
    id: String(issue.id),
    shortId: issue.shortId,
    title: issue.title,
    culprit: issue.culprit,
    level: issue.level,
    status: issue.status,
    count: String(issue.timesSeen),
    firstSeen: iso(issue.firstSeen),
    lastSeen: iso(issue.lastSeen),
    project: { id: String(issue.projectId), slug: issue.projectSlug },
  };
}

/**
 * `GET /projects/{org}/{project}/issues/`. With no query Sentry's CLI asks
 * for every status ("If omitted, no filtering is applied"), unlike the web
 * UI, which defaults to unresolved.
 */
export const listIssues: CliHandler = async (context, args) => {
  const project = await projectOf(context, args);

  if (project === null) {
    return notFound();
  }

  const { query, cursor } = readQuery(context.url, IssueListQuery);
  const search = parseSearch(query);

  const rows = await context.deps.issues.list({
    organizationId: context.caller.organization.id,
    projectId: project.id,
    status: search.status,
    level: search.level,
    query: search.text === "" ? null : search.text,
    tag: search.tag,
    sort: "date",
    cursor,
    limit: PAGE_SIZE + 1,
  });

  const { rows: issues, page } = pageOf(rows, (last) => encodeCursor([last.lastSeen, last.id]));

  return paged(issues.map(toSentryIssue), context.url, page);
};

/** The web's bulk endpoint takes at most this many ids too (src/api/issues.ts). */
const MAX_IDS = 100;

// Strict, because a missing filter means "every issue in the project" (that is
// how sentry-cli sends --all): a misspelt or unknown parameter must not
// silently widen a change to everything.
const BulkQuery = z.strictObject({
  id: z
    .union([IdParam.transform((id) => [id]), z.array(IdParam)])
    .pipe(z.array(z.number()).max(MAX_IDS))
    .nullable()
    .default(null),
  status: SentryStatus.nullable().default(null),
});

const BulkBody = z.object({
  status: SentryStatus.or(
    z.literal("resolvedInNextRelease").refine(() => false, {
      error: "Zentry has no releases, so it cannot resolve in the next one",
    }),
  ).pipe(z.enum(["unresolved", "resolved", "ignored"])),
  // sentry-cli always sends the key, null unless snoozing, which Zentry has not built.
  snoozeDuration: z.null({ error: "Zentry cannot snooze an issue for a while; mute it" }),
});

/**
 * readQuery drops empty values, as the web UI clears a filter that way. Here
 * an empty `id=` (an unset shell variable) would turn a change of one issue
 * into a change of all of them, so it is refused before parsing.
 */
function refuseEmptyFilters(url: URL): void {
  for (const [name, value] of url.searchParams) {
    if (value.trim() === "") {
      throw new InvalidRequest(`${name} is empty; leave it out to change every issue`);
    }
  }
}

/** Every id the caller named must be one it can change, or nothing changes. */
async function refuseUnknownIds(
  context: CliContext,
  projectId: number,
  ids: number[],
): Promise<void> {
  const changeable = await context.deps.issues.changeableIn(projectId, ids);
  const unknown = ids.filter((id) => !changeable.has(id));

  if (unknown.length > 0) {
    throw new InvalidRequest(
      `not issues of this project that can be changed by hand: ${unknown.join(", ")} ` +
        `(a monitor's issue follows its monitor)`,
    );
  }
}

/**
 * `PUT /projects/{org}/{project}/issues/`: `sentry-cli issues resolve`,
 * `mute` and `unresolve`, for the issues named by `id`, those with `status`,
 * or (with neither, from `--all`) every issue in the project.
 */
export const updateIssues: CliHandler = async (context, args) => {
  const project = await projectOf(context, args);

  if (project === null) {
    return notFound();
  }

  refuseEmptyFilters(context.url);

  const filter = readQuery(context.url, BulkQuery);
  const { status } = await readBody(context.request, BulkBody);

  if (filter.id !== null) {
    await refuseUnknownIds(context, project.id, filter.id);
  }

  const ids = await context.deps.issues.projectIssueIds({
    projectId: project.id,
    ids: filter.id,
    status: filter.status,
    target: status,
    limit: BULK_LIMIT + 1,
  });

  if (ids.length > BULK_LIMIT) {
    throw new InvalidRequest(
      `more than ${BULK_LIMIT} issues match; narrow the change with --status or --id`,
    );
  }

  // Sentry answers a change that matched nothing with 204; issues already at
  // the status count as nothing, so both "nothing happened" cases agree.
  if (ids.length === 0) {
    return new Response(null, { status: 204 });
  }

  await applyStatus(context.deps, {
    organizationId: context.caller.organization.id,
    issueIds: ids,
    status,
    userId: context.caller.user.id,
    now: context.now,
  });

  // Sentry echoes the change; the CLI only checks that it succeeded.
  return Response.json({ status, statusDetails: {} });
};

// ── Events ───────────────────────────────────────────────────────────────────

const EventListQuery = z.object({
  cursor: CursorParam.pipe(
    z
      .tuple([IntParam, z.string().min(1)])
      .transform(([timestamp, eventId]): EventCursor => ({ timestamp, eventId })),
  )
    // An absent cursor is the first page.
    .default(NEWEST),
});

type SentryEvent = { id: string; eventID: string; dateCreated: string; title?: string };

/** An event stored without a title leaves the key out; sentry-cli defaults it to "". */
function toSentryEvent(event: ProjectEventRow): SentryEvent {
  const sentry: SentryEvent = {
    id: event.eventId,
    eventID: event.eventId,
    dateCreated: iso(event.timestamp),
  };

  if (event.title !== null) {
    sentry.title = event.title;
  }

  return sentry;
}

/**
 * `GET /projects/{org}/{project}/events/`. User and tags are left out, so
 * `--show-user` and `--show-tags` print "-". The index keeps only a one-line
 * user label (the first of email, username, id and address that was set), and
 * the CLI's user has those as separate fields: putting the label in one of
 * them would mislabel it. The full user and tags are in each event's JSON in
 * R2, a read per event that a list is not worth.
 */
export const listEvents: CliHandler = async (context, args) => {
  const project = await projectOf(context, args);

  if (project === null) {
    return notFound();
  }

  const { cursor } = readQuery(context.url, EventListQuery);
  const rows = await context.deps.events.listForProject(project.id, cursor, PAGE_SIZE + 1);

  const { rows: events, page } = pageOf(rows, (last) =>
    encodeCursor([last.timestamp, last.eventId]),
  );

  return paged(events.map(toSentryEvent), context.url, page);
};

// ── Monitors ─────────────────────────────────────────────────────────────────

/**
 * Sentry's monitor list holds cron monitors only; its uptime and metric
 * monitors live elsewhere. A paused monitor is Sentry's "disabled".
 */
function toSentryMonitor(monitor: ApiMonitor) {
  if (monitor.type !== "cron") {
    return [];
  }

  return [
    {
      id: monitor.id,
      slug: monitor.config.slug,
      name: monitor.name,
      status: monitor.status === "paused" ? "disabled" : "active",
    },
  ];
}

/** Every cron monitor in one page; the store's list is capped at 100. */
export const listMonitors: CliHandler = async (context) => {
  const monitors = await context.deps.monitors.list(context.caller.organization.id, {
    kind: "all",
  });

  return Response.json(monitors.flatMap(toSentryMonitor));
};
