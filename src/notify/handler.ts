// The notify queue's consumer. DESIGN.md §18.1. A `drain` message handles the
// outbox in id order; a `digest` message flushes one project's window. The
// consumer runs one batch at a time (max_concurrency 1), so two deliveries
// never handle the same row or window at once.

import { errorText, logError, logInfo } from "@/shared/log";
import type { OutboxItem } from "@/shared/notify";
import { MINUTE, SECOND } from "@/shared/time";
import type { NotifyMessage } from "@/shared/types";

import { flushDigest, handleAlert } from "./alerts";
import type { NotifyDeps } from "./deps";
import { handleQuota, handleSpike, handleWeeklyReport, handleWorkflow } from "./jobs";
import { SendDeferred } from "./providers";

/** Rows per drain; a full drain asks for another rather than run long. */
export const DRAIN_LIMIT = 25;

/** A row that has failed this often is dropped, so it cannot block those after it. */
const MAX_ATTEMPTS = 5;

/** Seconds before a failed message is delivered again. */
const RETRY_DELAY = 60;

async function handleItem(deps: NotifyDeps, item: OutboxItem): Promise<void> {
  switch (item.kind) {
    case "new_issue":
    case "regression": {
      return handleAlert(deps, item);
    }

    case "status": {
      return handleWorkflow(deps, item);
    }

    case "quota": {
      return handleQuota(deps, item);
    }

    case "spike": {
      return handleSpike(deps, item);
    }

    case "weekly_report": {
      return handleWeeklyReport(deps, item);
    }
  }
}

/** How long a row a provider deferred steps aside, letting the rows behind it go. */
const DEFER_FOR = 5 * MINUTE;

/** The drain left deferred rows; it is retried once they are due again. */
class DrainDeferred extends Error {}

/**
 * Handles up to DRAIN_LIMIT rows. A row that fails stays, with one more
 * attempt counted, and the drain throws once the rest are done, so the
 * message is retried. A row a provider deferred stays too, with nothing
 * counted, and steps aside for DEFER_FOR; the provider is paused for the rest
 * of the drain while the other carries on (notify/providers.ts). Push needs
 * no configuration, so every row is handled even while email is off.
 */
export async function drainOutbox(deps: NotifyDeps): Promise<void> {
  const now = deps.now();
  const entries = await deps.store.outbox(DRAIN_LIMIT, now);
  let failures = 0;
  let deferrals = 0;

  for (const { item, attempts } of entries) {
    try {
      if (attempts < MAX_ATTEMPTS) {
        await handleItem(deps, item);
      } else {
        logError("dropping notification after repeated failures", { id: item.id, kind: item.kind });
      }

      await deps.store.handled(item.id);
    } catch (cause) {
      if (cause instanceof SendDeferred) {
        deferrals += 1;
        await deps.store.deferred(item.id, now + DEFER_FOR);
        continue;
      }

      failures += 1;
      logError("notification failed", { id: item.id, kind: item.kind, error: errorText(cause) });
      await deps.store.failed(item.id);
    }
  }

  if (failures > 0) {
    throw new Error(`${failures} of ${entries.length} notifications failed`);
  }

  if (deferrals > 0) {
    throw new DrainDeferred(`${deferrals} of ${entries.length} notifications deferred`);
  }

  if (entries.length === DRAIN_LIMIT) {
    await deps.drainAgain();
  }
}

export async function handleNotifyBatch(
  batch: MessageBatch<NotifyMessage>,
  deps: NotifyDeps,
): Promise<void> {
  // Any number of drain requests in one batch need only one drain.
  const drains = batch.messages.filter((message) => message.body.kind === "drain");

  if (drains.length > 0) {
    try {
      await drainOutbox(deps);
      drains.forEach((message) => message.ack());
    } catch (cause) {
      logInfo("drain will be retried", { error: errorText(cause) });
      const delaySeconds = cause instanceof DrainDeferred ? DEFER_FOR / SECOND : RETRY_DELAY;

      drains.forEach((message) => message.retry({ delaySeconds }));
    }
  }

  for (const message of batch.messages) {
    const { body } = message;

    if (body.kind === "digest") {
      try {
        await flushDigest(deps, body.project_id);
        message.ack();
      } catch (cause) {
        logError("digest failed", { project_id: body.project_id, error: errorText(cause) });
        message.retry({ delaySeconds: RETRY_DELAY });
      }
    }
  }
}
