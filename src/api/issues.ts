// Issue endpoints: list, detail, status changes, delete, tags, stats, activity.

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
import { getBoolean, getString } from "@/shared/json";

import type { ApiContext, Handler } from "./context";
import {
  badRequest,
  decodeCursor,
  encodeCursor,
  intParam,
  noContent,
  notFound,
  readObject,
  textParam,
} from "./http";
import { fillSeries, LAST_14_DAYS, LAST_24_HOURS, LAST_30_DAYS, windowStart } from "./series";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const TOP_TAG_VALUES = 10;
const STATUSES: IssueStatus[] = ["unresolved", "resolved", "ignored"];
const STATUS_REQUIRED = "status must be unresolved, resolved or ignored";
const SORTS: IssueSort[] = ["date", "new", "freq"];

function parseStatus(text: string | null): IssueStatus | null {
  return STATUSES.find((status) => status === text) ?? null;
}

function parseTag(text: string | null): Pair | null {
  const separator = text?.indexOf(":") ?? -1;

  return text === null || separator < 1
    ? null
    : [text.slice(0, separator), text.slice(separator + 1)];
}

function parseCursor(url: URL): IssueCursor | null {
  const [value = "", id = ""] = decodeCursor(url) ?? [];

  return /^\d+$/.test(value) && /^\d+$/.test(id) ? { value: Number(value), id: Number(id) } : null;
}

function parseFilter(context: ApiContext): IssueFilter {
  const { url } = context;
  const status = textParam(url, "status") ?? "unresolved";

  return {
    organizationId: context.organizationId,
    projectId: parseId(textParam(url, "project") ?? ""),
    status: status === "all" ? null : (parseStatus(status) ?? "unresolved"),
    level: textParam(url, "level"),
    query: textParam(url, "query"),
    tag: parseTag(textParam(url, "tag")),
    sort: SORTS.find((sort) => sort === textParam(url, "sort")) ?? "date",
    cursor: parseCursor(url),
    limit: Math.min(Math.max(intParam(url, "limit", DEFAULT_LIMIT), 1), MAX_LIMIT),
  };
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

async function issueOf(
  context: ApiContext,
  idText: string | undefined,
): Promise<IssueRecord | null> {
  const id = parseId(idText ?? "");

  return id === null ? null : context.deps.issues.find(context.organizationId, id);
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
  const ids = context.url.searchParams.getAll("id").flatMap((text) => parseId(text) ?? []);
  const body = (await readObject(context.request)) ?? {};
  const status = parseStatus(getString(body, "status"));

  if (ids.length === 0 || ids.length > MAX_LIMIT) {
    return badRequest(`pass between 1 and ${MAX_LIMIT} id parameters`);
  }

  if (status === null) {
    return badRequest(STATUS_REQUIRED);
  }

  await changeStatus(context, ids, status);

  return noContent();
};

export const getIssue: Handler = async (context, [idText]) => {
  const issue = await issueOf(context, idText);

  return issue === null ? notFound() : Response.json((await withStats(context, [issue]))[0]);
};

/** Accepts `status`, `hasSeen: true` (the user opened the issue), or both. */
export const updateIssue: Handler = async (context, [idText]) => {
  const issue = await issueOf(context, idText);
  const body = (await readObject(context.request)) ?? {};
  const status = parseStatus(getString(body, "status"));
  const seen = getBoolean(body, "hasSeen") === true;

  if (issue === null) {
    return notFound();
  }

  if (status === null && !seen) {
    return badRequest(STATUS_REQUIRED);
  }

  if (status !== null) {
    await changeStatus(context, [issue.id], status);
  }

  if (seen) {
    await context.deps.issues.markSeen(context.user.id, issue, context.now);
  }

  const updated = await context.deps.issues.find(context.organizationId, issue.id);

  return Response.json((await withStats(context, updated === null ? [] : [updated]))[0]);
};

/** Removes the issue's R2 objects first, then the issue and everything it owns. */
export const deleteIssue: Handler = async (context, [idText]) => {
  const issue = await issueOf(context, idText);

  if (issue === null) {
    return notFound();
  }

  await context.deps.blobs.deleteAll(issue.projectId, await context.deps.events.idsOf(issue.id));
  await context.deps.issues.delete(context.organizationId, issue.id);

  return noContent();
};

export const getIssueTags: Handler = async (context, [idText]) => {
  const issue = await issueOf(context, idText);

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

const PERIODS = new Map([
  ["24h", LAST_24_HOURS],
  ["14d", LAST_14_DAYS],
  ["30d", LAST_30_DAYS],
]);

function sum(hours: IssueHour[], pick: (hour: IssueHour) => number): number {
  return hours.reduce((total, hour) => total + pick(hour), 0);
}

export const getIssueStats: Handler = async (context, [idText]) => {
  const issue = await issueOf(context, idText);
  const period = PERIODS.get(textParam(context.url, "period") ?? "24h") ?? LAST_24_HOURS;

  if (issue === null) {
    return notFound();
  }

  const window = { ...period, now: context.now };
  const hours = await context.deps.issues.hourlyCounts([issue.id], windowStart(window));

  return Response.json({
    points: fillSeries(hours, window),
    stored: sum(hours, (hour) => hour.stored),
    total: sum(hours, (hour) => hour.count),
  } satisfies ApiIssueStats);
};

export const getIssueActivity: Handler = async (context, [idText]) => {
  const issue = await issueOf(context, idText);

  return issue === null ? notFound() : Response.json(await context.deps.issues.activity(issue.id));
};

/** Resolves a short id such as `API-42`. The slug may itself contain dashes. */
export const getShortId: Handler = async (context, [shortId = ""]) => {
  const separator = shortId.lastIndexOf("-");
  const number = parseId(shortId.slice(separator + 1));
  const slug = shortId.slice(0, Math.max(separator, 0));

  const issue =
    number === null || slug === ""
      ? null
      : await context.deps.issues.findByShortId(context.organizationId, slug, number);

  return issue === null ? notFound() : Response.json((await withStats(context, [issue]))[0]);
};
