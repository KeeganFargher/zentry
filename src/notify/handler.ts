// The notify queue's consumer. DESIGN.md §18.1. A `drain` message handles the
// outbox in id order; a `digest` message flushes one project's window. The
// consumer runs one batch at a time (max_concurrency 1), so two deliveries
// never handle the same row or window at once.

import { errorText, logError, logInfo } from "@/shared/log";
import type { OutboxItem } from "@/shared/notify";
import type { NotifyMessage } from "@/shared/types";

import { flushDigest, handleAlert } from "./alerts";
import type { MailDeps, NotifyDeps } from "./deps";
import { handleQuota, handleSpike, handleWeeklyReport, handleWorkflow } from "./jobs";
import { SendDeferred } from "./mailer";

/** Rows per drain; a full drain asks for another rather than run long. */
export const DRAIN_LIMIT = 25;

/** A row that has failed this often is dropped, so it cannot block those after it. */
const MAX_ATTEMPTS = 5;

/** Seconds before a failed message is delivered again. */
const RETRY_DELAY = 60;

function withMail(deps: NotifyDeps): MailDeps | null {
  return deps.config === null ? null : { ...deps, config: deps.config };
}

async function handleItem(deps: MailDeps, item: OutboxItem): Promise<void> {
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

/**
 * Handles up to DRAIN_LIMIT rows. A row that fails stays, with one more
 * attempt counted, and the drain throws once the rest are done, so the
 * message is retried. A deferred send stops the drain at once and counts
 * nothing. With email not configured, rows are dropped unsent.
 */
export async function drainOutbox(deps: NotifyDeps): Promise<void> {
  const mail = withMail(deps);
  const entries = await deps.store.outbox(DRAIN_LIMIT);
  let failures = 0;

  for (const { item, attempts } of entries) {
    try {
      if (mail !== null && attempts < MAX_ATTEMPTS) {
        await handleItem(mail, item);
      } else if (mail !== null) {
        logError("dropping notification after repeated failures", { id: item.id, kind: item.kind });
      }

      await deps.store.handled(item.id);
    } catch (cause) {
      // Cloudflare asked to wait: stop here, and leave this row and the rest
      // as they are for the retry.
      if (cause instanceof SendDeferred) {
        throw cause;
      }

      failures += 1;
      logError("notification failed", { id: item.id, kind: item.kind, error: errorText(cause) });
      await deps.store.failed(item.id);
    }
  }

  if (failures > 0) {
    throw new Error(`${failures} of ${entries.length} notifications failed`);
  }

  if (entries.length === DRAIN_LIMIT) {
    await deps.drainAgain();
  }
}

async function flush(deps: NotifyDeps, projectId: number): Promise<void> {
  const mail = withMail(deps);

  if (mail !== null) {
    await flushDigest(mail, projectId);
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
      drains.forEach((message) => message.retry({ delaySeconds: RETRY_DELAY }));
    }
  }

  for (const message of batch.messages) {
    const { body } = message;

    if (body.kind === "digest") {
      try {
        await flush(deps, body.project_id);
        message.ack();
      } catch (cause) {
        logError("digest failed", { project_id: body.project_id, error: errorText(cause) });
        message.retry({ delaySeconds: RETRY_DELAY });
      }
    }
  }
}
