// The queue consumer. DESIGN.md §7: normalize each message, then read, plan,
// store blobs and commit once for the whole batch. Messages are acked only
// after the commit.

import { z } from "zod";

import type { EventBlob } from "@/blobs/events";
import { groupHourKeys, prepareEvent } from "@/core/buckets";
import type { Prepared } from "@/core/buckets";
import { normalizeEvent } from "@/core/normalize";
import { planBatch } from "@/core/plan";
import { WireEvent } from "@/core/wire";
import type { BatchKeys } from "@/db/batch";
import { jsonText } from "@/shared/json";
import { errorText, logError } from "@/shared/log";
import type {
  BatchState,
  BatchWrites,
  EventKey,
  GroupHourKey,
  GroupHourStored,
} from "@/shared/plan";
import { hourBucket } from "@/shared/time";
import type { QueueMessage } from "@/shared/types";

export type ConsumerDeps = {
  readState: (keys: BatchKeys) => Promise<BatchState>;
  readStored: (keys: GroupHourKey[]) => Promise<GroupHourStored[]>;
  /** Returns how many notifications the commit queued in the outbox. */
  commit: (writes: BatchWrites, now: number, inputs: EventKey[]) => Promise<number>;
  /** Clears the metric pending rows of events dropped before the commit. */
  release: (inputs: EventKey[]) => Promise<void>;
  putBlobs: (blobs: EventBlob[]) => Promise<void>;
  loadSpill: (key: string) => Promise<string | null>;
  deleteSpill: (keys: string[]) => Promise<void>;
  /** Wakes the notify consumer to drain the outbox (DESIGN.md §18). */
  notify: () => Promise<void>;
  maxStoredPerGroupHour: number;
  now: () => number;
};

/** After this many deliveries a failing batch is processed one message at a time. */
const ISOLATE_AFTER_ATTEMPTS = 3;

async function loadPayload(message: QueueMessage, deps: ConsumerDeps): Promise<string | null> {
  return message.spill_key === null ? message.payload : deps.loadSpill(message.spill_key);
}

// The event is validated here, once, as it comes off the queue. Everything
// after this works on the typed result.
const EventPayload = jsonText(WireEvent);

/** Null when the payload is not a JSON object; retrying would not help. */
function normalizeMessage(message: QueueMessage, payload: string): Prepared | null {
  const parsed = EventPayload.safeParse(payload);

  if (!parsed.success) {
    logError("dropping unparseable event", {
      project_id: message.project_id,
      event_id: message.event_id,
      error: z.prettifyError(parsed.error),
    });

    return null;
  }

  return prepareEvent(
    normalizeEvent(parsed.data, {
      projectId: message.project_id,
      eventId: message.event_id,
      receivedAt: message.received_at,
      clientIp: message.client_ip,
      userAgent: message.user_agent,
      sentAt: message.sent_at,
    }),
  );
}

/** Null when the event cannot be stored; retrying would not help. */
async function prepare(message: QueueMessage, deps: ConsumerDeps): Promise<Prepared | null> {
  const payload = await loadPayload(message, deps);

  if (payload === null) {
    logError("dropping event whose spilled payload is gone", {
      project_id: message.project_id,
      event_id: message.event_id,
    });

    return null;
  }

  // Parsing is inside the try as well as normalizing: anything either throws
  // depends only on the payload, so it would throw the same way on every retry,
  // and a throw here would otherwise send the whole batch back to the queue.
  try {
    return normalizeMessage(message, payload);
  } catch (cause) {
    logError("dropping event that could not be normalized", {
      project_id: message.project_id,
      event_id: message.event_id,
      error: errorText(cause),
    });

    return null;
  }
}

function batchKeys(prepared: Prepared[], now: number): BatchKeys {
  return {
    events: prepared.map(({ event }) => ({ p: event.projectId, e: event.eventId })),
    hashes: prepared.map(({ event, hash }) => ({ p: event.projectId, h: hash })),
    projectIds: [...new Set(prepared.map(({ event }) => event.projectId))],
    hour: hourBucket(now),
  };
}

/** Steps B to E for a set of messages. Throws if anything could not be stored. */
export async function processMessages(messages: QueueMessage[], deps: ConsumerDeps): Promise<void> {
  const results = await Promise.all(messages.map((message) => prepare(message, deps)));
  const prepared = results.filter((result) => result !== null);
  const now = deps.now();

  // A dropped event will never be counted. Releasing its pending row now
  // stops it from holding every metric window that contains it as unknown.
  const dropped = messages.filter((_, index) => results[index] === null);

  if (dropped.length > 0) {
    await deps.release(dropped.map((message) => ({ p: message.project_id, e: message.event_id })));
  }

  if (prepared.length > 0) {
    const state = await deps.readState(batchKeys(prepared, now));
    const storedThisHour = await deps.readStored(groupHourKeys(prepared, state.knownGroups));

    const plan = planBatch({
      prepared,
      state: { ...state, storedThisHour },
      now,
      maxStoredPerGroupHour: deps.maxStoredPerGroupHour,
    });

    await deps.putBlobs(
      plan.stored.map(({ event, json }) => ({
        projectId: event.projectId,
        eventId: event.eventId,
        json,
      })),
    );

    if (
      (await deps.commit(
        plan.writes,
        now,
        prepared.map(({ event }) => ({ p: event.projectId, e: event.eventId })),
      )) > 0
    ) {
      await wake(deps);
    }
  }
}

/**
 * The outbox rows are committed, so a failure here loses nothing: the hourly
 * sweep wakes the notify consumer anyway. It must not fail the batch, whose
 * retry would find its events already stored.
 */
async function wake(deps: ConsumerDeps): Promise<void> {
  try {
    await deps.notify();
  } catch (cause) {
    logError("could not wake the notify consumer", { error: errorText(cause) });
  }
}

/**
 * Runs only after the messages are acked. A failure here throws, so it is seen,
 * but cannot send committed events back to the queue: an acked message stays
 * acked. The bucket's 7-day lifecycle rule on `spill/` removes what is left.
 */
async function deleteSpilled(messages: QueueMessage[], deps: ConsumerDeps): Promise<void> {
  await deps.deleteSpill(messages.flatMap((message) => message.spill_key ?? []));
}

async function processOneByOne(
  batch: MessageBatch<QueueMessage>,
  deps: ConsumerDeps,
): Promise<void> {
  const acked: QueueMessage[] = [];

  for (const message of batch.messages) {
    try {
      await processMessages([message.body], deps);
      message.ack();
      acked.push(message.body);
    } catch (cause) {
      logError("message failed", { event_id: message.body.event_id, error: errorText(cause) });
      message.retry();
    }
  }

  await deleteSpilled(acked, deps);
}

export async function handleBatch(
  batch: MessageBatch<QueueMessage>,
  deps: ConsumerDeps,
): Promise<void> {
  const struggling = batch.messages.some((message) => message.attempts >= ISOLATE_AFTER_ATTEMPTS);

  if (struggling) {
    await processOneByOne(batch, deps);

    return;
  }

  const messages = batch.messages.map((message) => message.body);

  try {
    await processMessages(messages, deps);
  } catch (cause) {
    logError("batch failed", { size: messages.length, error: errorText(cause) });
    batch.retryAll();

    return;
  }

  batch.ackAll();
  await deleteSpilled(messages, deps);
}
