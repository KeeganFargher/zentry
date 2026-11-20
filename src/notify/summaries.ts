// Each issue's push summary: written by Workers AI the first time the issue is
// pushed, then reused for its later pushes. DESIGN.md §19.2.

import type { DigestItem } from "@/core/email-messages";
import { PROMPT_VERSION, summaryPrompt } from "@/core/issue-summary";
import {
  alertPush,
  DIGEST_LISTED,
  digestPush,
  summaryDigestPush,
  summaryPush,
} from "@/core/push-messages";
import type { DigestLine } from "@/core/push-messages";
import { errorText, logError } from "@/shared/log";
import type { EventSummary, IssueNotice, IssueSummary } from "@/shared/notify";
import type { PushContent } from "@/shared/push";

import type { NotifyDeps } from "./deps";

/** The issue's latest stored event, read at most once however often it is asked for. */
export type EventReader = () => Promise<EventSummary | null>;

/**
 * Null means no event is stored: it was sampled out or aged out. An R2 error
 * throws, from every call, so nobody mistakes it for "no event".
 */
export function eventReader(deps: NotifyDeps, issue: IssueNotice): EventReader {
  let pending: Promise<EventSummary | null> | undefined;

  return async () => (pending ??= deps.latestEvent(issue));
}

/**
 * The event for the alert email. An email has always gone out without the
 * event's details when R2 could not be read, rather than not at all.
 */
export async function eventForEmail(
  read: EventReader,
  issue: IssueNotice,
): Promise<EventSummary | null> {
  try {
    return await read();
  } catch (cause) {
    logError("alert event unreadable", { group_id: issue.id, error: errorText(cause) });

    return null;
  }
}

export type SummaryLookup = { ok: true; summary: IssueSummary } | { ok: false; error: string };

/**
 * The stored summary, or a new one. The event is read only when a summary has
 * to be written. A model failure is returned for the caller to fall back on;
 * a failing store or R2 read throws, so the row is retried rather than a
 * summary written from less than there is being kept for good.
 */
export async function summaryFor(
  deps: NotifyDeps,
  issue: IssueNotice,
  read: EventReader,
): Promise<SummaryLookup> {
  const stored = await deps.summaries.get(issue.id, PROMPT_VERSION);

  if (stored !== null) {
    return { ok: true, summary: stored };
  }

  const event = await read();
  const result = await deps.summarize(summaryPrompt({ issue, event }));

  if (!result.ok) {
    return result;
  }

  await deps.summaries.put({
    ...result.summary,
    groupId: issue.id,
    promptVersion: PROMPT_VERSION,
    model: result.model,
    eventId: event?.eventId ?? null,
    createdAt: deps.now(),
  });

  return { ok: true, summary: result.summary };
}

// The push path's one fallback, chosen on purpose (DESIGN.md §19.2): an alert
// must not depend on Workers AI being up. The plain push is today's text, and
// the failure is logged so a broken summarizer is seen rather than silent.
function plainBecause(error: string, issue: IssueNotice): void {
  logError("push summary failed", { group_id: issue.id, error });
}

/** One issue's alert push: summarized, or plain when the model fails. */
export async function alertPushContent(
  deps: NotifyDeps,
  item: DigestItem,
  read: EventReader,
): Promise<PushContent> {
  const lookup = await summaryFor(deps, item.issue, read);

  if (!lookup.ok) {
    plainBecause(lookup.error, item.issue);

    return alertPush(item.issue, item.reason);
  }

  const event = await read();

  return summaryPush({ ...item, summary: lookup.summary, environment: event?.environment ?? "" });
}

/**
 * A digest push: the listed issues' headlines, or the plain digest when any
 * of them cannot be summarized, so one push never mixes the two styles.
 * Only the listed issues are summarized; the rest are counted, and get theirs
 * when they are next pushed on their own.
 */
export async function digestPushContent(
  deps: NotifyDeps,
  items: DigestItem[],
): Promise<PushContent> {
  const listed: DigestLine[] = [];

  for (const { issue } of items.slice(0, DIGEST_LISTED)) {
    const lookup = await summaryFor(deps, issue, eventReader(deps, issue));

    if (!lookup.ok) {
      plainBecause(lookup.error, issue);

      return digestPush(items);
    }

    listed.push({ issue, summary: lookup.summary });
  }

  return summaryDigestPush(listed, items.length);
}
