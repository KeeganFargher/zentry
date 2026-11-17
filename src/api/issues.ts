// Issue endpoints: list, detail, status changes, delete, tags, stats, activity.

import { z } from "zod";

import type { IssueCursor, IssueFilter, IssueHour, IssueRecord, IssueSort } from "@/db/issues";
import type {
  ApiIssue,
  ApiIssueList,
  ApiIssueStats,
  ApiTag,
  IssueStatus,
  Pair,
} from "@/shared/contract";
import { parseId } from "@/shared/ids";

import type { ApiContext, Handler } from "./context";
import {
  CursorParam,
  encodeCursor,
  IdParam,
  IntParam,
  noContent,
  notFound,
  readBody,
  readParams,
  readQuery,
} from "./http";
import { fillSeries, LAST_14_DAYS, LAST_24_HOURS, LAST_30_DAYS, windowStart } from "./series";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const TOP_TAG_VALUES = 10;
const STATUS_REQUIRED = "pass a status, hasSeen: true, or both";

const Status = z.enum(["unresolved", "resolved", "ignored"]) satisfies z.ZodType<IssueStatus>;
const Sort = z.enum(["date", "new", "freq"]) satisfies z.ZodType<IssueSort>;

/** `key:value`; the key may not be empty, the value may hold further colons. */
const TagParam = z
  .string()
  .regex(/^[^:]+:/, "must be key:value")
  .transform((text): Pair => {
    const separator = text.indexOf(":");

    return [text.slice(0, separator), text.slice(separator + 1)];
  });

const IssueCursorParam = CursorParam.pipe(
  z.tuple([IntParam, IntParam]).transform(([value, id]): IssueCursor => ({ value, id })),
);

const IssueListQuery = z.object({
  project: IdParam.nullable().default(null),
  // "all" lifts the status filter.
  status: z
    .union([Status, z.literal("all")])
    .default("unresolved")
    .transform((status) => (status === "all" ? null : status)),
  level: z.string().nullable().default(null),
  query: z.string().nullable().default(null),
  tag: TagParam.nullable().default(null),
  sort: Sort.default("date"),
  cursor: IssueCursorParam.nullable().default(null),
  limit: IntParam.pipe(z.number().min(1).max(MAX_LIMIT)).default(DEFAULT_LIMIT),
});

const IssueIdsQuery = z.object({
  id: z
    .union([IdParam.transform((id) => [id]), z.array(IdParam)])
    .pipe(z.array(z.number()).min(1).max(MAX_LIMIT)),
});

const UpdateIssuesBody = z.object({ status: Status });

const UpdateIssueBody = z
  .object({
    status: Status.nullable().default(null),
    hasSeen: z.literal(true).optional(),
  })
  .refine((body) => body.status !== null || body.hasSeen === true, STATUS_REQUIRED);

const StatsQuery = z.object({ period: z.enum(["24h", "14d", "30d"]).default("24h") });

function parseFilter(context: ApiContext): IssueFilter {
  const { project, ...filter } = readQuery(context.url, IssueListQuery);

  return { ...filter, organizationId: context.organizationId, projectId: project };
}

function sortValue(issue: IssueRecord, sort: IssueSort): number {
  if (sort === "new") {
    return issue.firstSeen;
  }

  return sort === "freq" ? issue.timesSeen : issue.lastSeen;
}

async function withStats(context: ApiContext, issues: IssueRecord[]): Promise<ApiIssue[]> {
  const window = { ...LAST_24_HOURS, now: context.now };
  const ids = issues.map((issue) => issue.id);

  if (ids.length === 0) {
    return [];
  }

  const [hours, seen] = await Promise.all([
    context.deps.issues.hourlyCounts(ids, windowStart(window)),
    context.deps.issues.seenBy(context.user.id, ids),
  ]);

  return issues.map((issue) => ({
    ...issue,
    hasSeen: seen.has(issue.id),
    stats: fillSeries(
      hours.filter((hour) => hour.groupId === issue.id),
      window,
    ),
  }));
}

/** The issue named by the route's first parameter. */
async function issueOf(context: ApiContext, args: string[]): Promise<IssueRecord | null> {
  const [id] = readParams(args, z.tuple([IdParam]));

  return context.deps.issues.find(context.organizationId, id);
}

export const listIssues: Handler = async (context) => {
  const filter = parseFilter(context);
  const rows = await context.deps.issues.list({ ...filter, limit: filter.limit + 1 });
  const page = rows.slice(0, filter.limit);
  const last = page.at(-1);
  const hasMore = rows.length > filter.limit && last !== undefined;

  return Response.json({
    issues: await withStats(context, page),
    nextCursor: hasMore ? encodeCursor([sortValue(last, filter.sort), last.id]) : null,
  } satisfies ApiIssueList);
};

async function changeStatus(
  context: ApiContext,
  issueIds: number[],
  status: IssueStatus,
): Promise<void> {
  await context.deps.issues.setStatus({
    organizationId: context.organizationId,
    issueIds,
    status,
    userId: context.user.id,
    now: context.now,
  });
}

export const updateIssues: Handler = async (context) => {
  const { id: ids } = readQuery(context.url, IssueIdsQuery);
  const { status } = await readBody(context.request, UpdateIssuesBody);

  await changeStatus(context, ids, status);

  return noContent();
};

export const getIssue: Handler = async (context, args) => {
  const issue = await issueOf(context, args);

  return issue === null ? notFound() : Response.json((await withStats(context, [issue]))[0]);
};

/** Accepts `status`, `hasSeen: true` (the user opened the issue), or both. */
export const updateIssue: Handler = async (context, args) => {
  const issue = await issueOf(context, args);

  if (issue === null) {
    return notFound();
  }

  const { status, hasSeen } = await readBody(context.request, UpdateIssueBody);

  if (status !== null) {
    await changeStatus(context, [issue.id], status);
  }

  if (hasSeen === true) {
    await context.deps.issues.markSeen(context.user.id, issue, context.now);
  }

  const updated = await context.deps.issues.find(context.organizationId, issue.id);

  return Response.json((await withStats(context, updated === null ? [] : [updated]))[0]);
};

/** Removes the issue's R2 objects first, then the issue and everything it owns. */
export const deleteIssue: Handler = async (context, args) => {
  const issue = await issueOf(context, args);

  if (issue === null) {
    return notFound();
  }

  await context.deps.blobs.deleteAll(issue.projectId, await context.deps.events.idsOf(issue.id));
  await context.deps.issues.delete(context.organizationId, issue.id);

  return noContent();
};

export const getIssueTags: Handler = async (context, args) => {
  const issue = await issueOf(context, args);

  if (issue === null) {
    return notFound();
  }

  const tags = new Map<string, ApiTag>();

  for (const row of await context.deps.issues.topTags(issue.id, TOP_TAG_VALUES)) {
    const tag = tags.get(row.key) ?? { key: row.key, total: row.total, values: [] };

    tag.values.push({ value: row.value, count: row.count });
    tags.set(row.key, tag);
  }

  return Response.json([...tags.values()]);
};

const PERIODS = { "24h": LAST_24_HOURS, "14d": LAST_14_DAYS, "30d": LAST_30_DAYS };

function sum(hours: IssueHour[], pick: (hour: IssueHour) => number): number {
  return hours.reduce((total, hour) => total + pick(hour), 0);
}

export const getIssueStats: Handler = async (context, args) => {
  const issue = await issueOf(context, args);

  if (issue === null) {
    return notFound();
  }

  const { period } = readQuery(context.url, StatsQuery);
  const window = { ...PERIODS[period], now: context.now };
  const hours = await context.deps.issues.hourlyCounts([issue.id], windowStart(window));

  return Response.json({
    points: fillSeries(hours, window),
    stored: sum(hours, (hour) => hour.stored),
    total: sum(hours, (hour) => hour.count),
  } satisfies ApiIssueStats);
};

export const getIssueActivity: Handler = async (context, args) => {
  const issue = await issueOf(context, args);

  return issue === null ? notFound() : Response.json(await context.deps.issues.activity(issue.id));
};

/** Resolves a short id such as `API-42`. The slug may itself contain dashes. */
export const getShortId: Handler = async (context, args) => {
  const [shortId] = readParams(args, z.tuple([z.string()]));
  const separator = shortId.lastIndexOf("-");
  const number = parseId(shortId.slice(separator + 1));
  const slug = shortId.slice(0, Math.max(separator, 0));

  const issue =
    number === null || slug === ""
      ? null
      : await context.deps.issues.findByShortId(context.organizationId, slug, number);

  return issue === null ? notFound() : Response.json((await withStats(context, [issue]))[0]);
};
