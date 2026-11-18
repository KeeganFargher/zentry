// What the Expo push client sends and gets back. DESIGN.md §19. Shared
// because push/ produces these, notify/ and cron/ act on them, and worker.ts
// hands one to the other.

import type { PushChannel, PushData } from "./contract";

/** Expo refuses more than this many messages per request. */
export const SEND_BATCH = 100;

/** Expo refuses more than this many receipt ids per request. */
export const RECEIPT_BATCH = 1000;

/** One notification to one install. `channelId` names the Android channel the app created. */
export type PushMessage = {
  to: string;
  title: string;
  body: string;
  data: PushData;
  channelId: string;
};

/** Expo's answer for one message, in the order sent. */
export type PushTicket =
  | { status: "ok"; id: string }
  | { status: "error"; message: string; error: string | null };

export type PushReceipt =
  | { status: "ok" }
  | { status: "error"; message: string; error: string | null };

/**
 * A request Expo did not take. `retryable` is true for what Expo says to
 * retry with backoff (network errors, 429, 5xx); anything else will fail the
 * same way again.
 */
export type PushFailure = { ok: false; retryable: boolean; error: string };

export type PushResult<T> = { ok: true; value: T } | PushFailure;

/** A push as core/ builds it, before it is addressed to a device. */
export type PushContent = { channel: PushChannel; title: string; body: string; data: PushData };

/** Expo's reason for a failed push, with its error code when it gave one. */
export function pushError(failure: { error: string | null; message: string }): string {
  return failure.error === null ? failure.message : `${failure.error}: ${failure.message}`;
}
