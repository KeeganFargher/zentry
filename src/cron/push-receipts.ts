// Reads Expo's receipts for the pushes it accepted. DESIGN.md §19. A ticket
// only says Expo took the push; the receipt says whether FCM did. That is
// where a broken setup shows (InvalidCredentials, MismatchSenderId) and where
// most uninstalled apps are reported (DeviceNotRegistered), so it runs hourly.

import type { AwaitingReceipt, PushOutcome, ReceiptCursor, ReceiptWindow } from "@/db/pushes";
import { logError, logInfo } from "@/shared/log";
import { pushError, RECEIPT_BATCH } from "@/shared/push";
import type { PushReceipt, PushResult } from "@/shared/push";
import { DAY, MINUTE } from "@/shared/time";

/** Expo asks for receipts to be read about 15 minutes after sending … */
const RECEIPT_DELAY = 15 * MINUTE;

/** … and keeps them for a day. */
const RECEIPT_LIFETIME = DAY;

/** Pages of receipts per run; a run that fills them all leaves the rest for the next hour. */
const MAX_BATCHES = 10;

export type PushReceiptDeps = {
  awaiting: (
    window: ReceiptWindow,
    cursor: ReceiptCursor,
    limit: number,
  ) => Promise<AwaitingReceipt[]>;
  receipts: (ids: string[]) => Promise<PushResult<Map<string, PushReceipt>>>;
  settle: (key: string, outcome: PushOutcome) => Promise<void>;
  /** Settles pushes sent before `before` that never got a receipt; returns how many. */
  expire: (before: number) => Promise<number>;
  /**
   * The install the token belonged to is gone: stop pushing to that token. By
   * token, not device: the phone may have registered a new one since.
   */
  forgetPushToken: (pushToken: string) => Promise<void>;
  now: () => number;
};

async function settleReceipt(
  deps: PushReceiptDeps,
  push: AwaitingReceipt,
  receipt: PushReceipt,
): Promise<void> {
  if (receipt.status === "ok") {
    await deps.settle(push.key, { status: "delivered" });

    return;
  }

  if (receipt.error === "DeviceNotRegistered") {
    await deps.forgetPushToken(push.pushToken);
  } else {
    // Anything else is a setup problem worth seeing: wrong FCM credentials,
    // a payload too big, a device being flooded.
    logError("push not delivered", {
      key: push.key,
      error: receipt.error,
      message: receipt.message,
    });
  }

  await deps.settle(push.key, {
    status: "failed",
    error: pushError(receipt),
  });
}

/**
 * Reads one page of receipts. Returns where the next page starts, or null
 * when this was the last.
 */
async function readPage(
  deps: PushReceiptDeps,
  window: ReceiptWindow,
  cursor: ReceiptCursor,
): Promise<ReceiptCursor | null> {
  const awaiting = await deps.awaiting(window, cursor, RECEIPT_BATCH);
  const last = awaiting.at(-1);

  if (last === undefined) {
    return null;
  }

  const result = await deps.receipts(awaiting.map((push) => push.ticketId));

  // The next hour's run reads them again; receipts last a day.
  if (!result.ok) {
    logError("could not read push receipts", { error: result.error });

    return null;
  }

  for (const push of awaiting) {
    const receipt = result.value.get(push.ticketId);

    // No receipt yet: Expo is still waiting on FCM. Try next hour.
    if (receipt !== undefined) {
      await settleReceipt(deps, push, receipt);
    }
  }

  logInfo("push receipts read", { awaiting: awaiting.length, answered: result.value.size });

  return awaiting.length < RECEIPT_BATCH ? null : { createdAt: last.createdAt, key: last.key };
}

export async function checkPushReceipts(deps: PushReceiptDeps): Promise<void> {
  const now = deps.now();
  const window = { since: now - RECEIPT_LIFETIME, before: now - RECEIPT_DELAY };
  let cursor: ReceiptCursor | null = { createdAt: 0, key: "" };

  for (let page = 0; page < MAX_BATCHES && cursor !== null; page += 1) {
    cursor = await readPage(deps, window, cursor);
  }

  const expired = await deps.expire(window.since);

  if (expired > 0) {
    logInfo("push receipts never came", { expired });
  }
}
