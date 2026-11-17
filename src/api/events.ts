// Event endpoints: an issue's event list, and one full event from R2.

import { z } from "zod";

import type { EventCursor, EventRef, IssueRef } from "@/db/events";
import type { ApiEventList } from "@/shared/contract";
import { normalizeEventId, parseId } from "@/shared/ids";

import type { ApiContext, Handler } from "./context";
import { CursorParam, encodeCursor, IntParam, notFound, readQuery } from "./http";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

async function issueOf(context: ApiContext, idText: string | undefined): Promise<IssueRef | null> {
  const id = parseId(idText ?? "");

  return id === null ? null : context.deps.issues.find(context.organizationId, id);
}

const EventListQuery = z.object({
  cursor: CursorParam.pipe(
    z
      .tuple([IntParam, z.string().min(1)])
      .transform(([timestamp, eventId]): EventCursor => ({ timestamp, eventId })),
  )
    .nullable()
    .default(null),
  limit: IntParam.pipe(z.number().min(1).max(MAX_LIMIT)).default(DEFAULT_LIMIT),
});

export const listEvents: Handler = async (context, [idText]) => {
  const issue = await issueOf(context, idText);

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
export const getEvent: Handler = async (context, [idText, which = "latest"]) => {
  const issue = await issueOf(context, idText);
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
