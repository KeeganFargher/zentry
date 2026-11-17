// Event endpoints: an issue's event list, and one full event from R2.

import { z } from "zod";

import { NEWEST } from "@/db/events";
import type { EventCursor, EventRef, IssueRef } from "@/db/events";
import type { ApiEventList } from "@/shared/contract";
import { normalizeEventId } from "@/shared/ids";

import type { ApiContext, Handler } from "./context";
import {
  CursorParam,
  encodeCursor,
  IdParam,
  IntParam,
  notFound,
  readParams,
  readQuery,
} from "./http";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

// Every events route is `issues/{id}/events/...`; the event route adds which event.
const IssueParams = z.tuple([IdParam], z.string());

/** The issue named by the route's first parameter. */
async function issueOf(context: ApiContext, args: string[]): Promise<IssueRef | null> {
  const [id] = readParams(args, IssueParams);

  return context.deps.issues.find(context.organizationId, id);
}

const EventListQuery = z.object({
  cursor: CursorParam.pipe(
    z
      .tuple([IntParam, z.string().min(1)])
      .transform(([timestamp, eventId]): EventCursor => ({ timestamp, eventId })),
  )
    // An absent cursor is the first page.
    .default(NEWEST),
  limit: IntParam.pipe(z.number().min(1).max(MAX_LIMIT)).default(DEFAULT_LIMIT),
});

export const listEvents: Handler = async (context, args) => {
  const issue = await issueOf(context, args);

  if (issue === null) {
    return notFound();
  }

  const { cursor, limit } = readQuery(context.url, EventListQuery);
  const rows = await context.deps.events.list(issue.id, cursor, limit + 1);
  const events = rows.slice(0, limit);
  const last = events.at(-1);
  const hasMore = rows.length > limit && last !== undefined;

  return Response.json({
    events,
    nextCursor: hasMore ? encodeCursor([last.timestamp, last.eventId]) : null,
  } satisfies ApiEventList);
};

async function findEvent(
  context: ApiContext,
  issue: IssueRef,
  which: string,
): Promise<EventRef | null> {
  const { events } = context.deps;
  const issueId = issue.id;

  if (which === "latest") {
    return events.latest(issueId);
  }

  if (which === "oldest") {
    return events.oldest(issueId);
  }

  const eventId = normalizeEventId(which);

  return eventId === null ? null : events.find(issue, eventId);
}

/**
 * Returns `ApiEventDetail`. The stored event is spliced into the response as
 * text, so the Worker never parses or re-serializes it.
 */
export const getEvent: Handler = async (context, args) => {
  const [, which] = readParams(args, z.tuple([z.string(), z.string()]));
  const issue = await issueOf(context, args);
  const ref = issue === null ? null : await findEvent(context, issue, which);

  if (issue === null || ref === null) {
    return notFound();
  }

  const [json, neighbours] = await Promise.all([
    context.deps.blobs.getJson(ref.projectId, ref.eventId),
    context.deps.events.neighbours(issue.id, ref),
  ]);

  if (json === null) {
    return notFound();
  }

  const previous = JSON.stringify(neighbours.previous);
  const next = JSON.stringify(neighbours.next);

  return new Response(`{"event":${json},"previousEventId":${previous},"nextEventId":${next}}`, {
    headers: { "content-type": "application/json" },
  });
};
