// The queue consumer. DESIGN.md §7: normalize each message, then read, plan,
// store blobs and commit once for the whole batch. Messages are acked only
// after the commit.

import type { EventBlob } from "@/blobs/events";
import { groupHourKeys, prepareEvent } from "@/core/buckets";
import type { Prepared } from "@/core/buckets";
import { normalizeEvent } from "@/core/normalize";
import { planBatch } from "@/core/plan";
import type { BatchKeys } from "@/db/batch";
import { asObject, parseJson } from "@/shared/json";
import { errorText, logError } from "@/shared/log";
import type { BatchState, BatchWrites, GroupHourKey, GroupHourStored } from "@/shared/plan";
import { hourBucket } from "@/shared/time";
import type { QueueMessage } from "@/shared/types";

export type ConsumerDeps = {
  readState: (keys: BatchKeys) => Promise<BatchState>;
  readStored: (keys: GroupHourKey[]) => Promise<GroupHourStored[]>;
  commit: (writes: BatchWrites, now: number) => Promise<void>;
  putBlobs: (blobs: EventBlob[]) => Promise<void>;
  loadSpill: (key: string) => Promise<string | null>;
  deleteSpill: (keys: string[]) => Promise<void>;
  maxStoredPerGroupHour: number;
  now: () => number;
};

/** After this many deliveries a failing batch is processed one message at a time. */
const ISOLATE_AFTER_ATTEMPTS = 3;

async function loadPayload(message: QueueMessage, deps: ConsumerDeps): Promise<string | null> {
  return message.spill_key === null ? message.payload : deps.loadSpill(message.spill_key);
}

/** Null when the payload is missing or is not a JSON object; retrying would not help. */
async function prepare(message: QueueMessage, deps: ConsumerDeps): Promise<Prepared | null> {
  const raw = asObject(parseJson((await loadPayload(message, deps)) ?? ""));

  if (raw === null) {
    logError("dropping unparseable event", {
      project_id: message.project_id,
      event_id: message.event_id,
    });

    return null;
  }

  try {
    return prepareEvent(
      normalizeEvent(raw, {
        projectId: message.project_id,
        eventId: message.event_id,
        receivedAt: message.received_at,
        clientIp: message.client_ip,
        userAgent: message.user_agent,
        sentAt: message.sent_at,
      }),
    );
  } catch (cause) {
    // The same input would fail the same way on every retry.
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

    await deps.commit(plan.writes, now);
  }

  await deps.deleteSpill(messages.flatMap((message) => message.spill_key ?? []));
}

async function processOneByOne(
  batch: MessageBatch<QueueMessage>,
  deps: ConsumerDeps,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      await processMessages([message.body], deps);
      message.ack();
    } catch (cause) {
      logError("message failed", { event_id: message.body.event_id, error: errorText(cause) });
      message.retry();
    }
  }
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

  try {
    await processMessages(
      batch.messages.map((message) => message.body),
      deps,
    );

    batch.ackAll();
  } catch (cause) {
    logError("batch failed", { size: batch.messages.length, error: errorText(cause) });
    batch.retryAll();
  }
}
