// Alert timing. DESIGN.md §18.4. An issue alerts at most once per interval
// per reason. Per project, the first alert goes out at once and opens a
// window; alerts inside it are held and sent together when it is due, as in
// Sentry's digests: at least 5 minutes after the last send, pushed back 30
// seconds by each new alert, and never more than 30 minutes after it.

import { MINUTE, SECOND } from "@/shared/time";

export const ALERT_INTERVAL = 30 * MINUTE;
export const DIGEST_MIN_DELAY = 5 * MINUTE;
export const DIGEST_INCREMENT = 30 * SECOND;
export const DIGEST_MAX_DELAY = 30 * MINUTE;

export type DigestWindow = { startedAt: number; dueAt: number };

/** Opened by a send at `now`. */
export function openWindow(now: number): DigestWindow {
  return { startedAt: now, dueAt: now + DIGEST_MIN_DELAY };
}

/** The window after one more alert arrives at `now`. */
export function extendWindow(window: DigestWindow, now: number): DigestWindow {
  const pushed = Math.max(window.startedAt + DIGEST_MIN_DELAY, now + DIGEST_INCREMENT);
  const capped = Math.min(pushed, window.startedAt + DIGEST_MAX_DELAY);

  return { ...window, dueAt: Math.max(window.dueAt, capped) };
}

/** Whether an issue that last alerted at `lastSent` may alert again at `now`. */
export function intervalPassed(lastSent: number, now: number): boolean {
  return now - lastSent >= ALERT_INTERVAL;
}

/** Whole seconds until `dueAt`, at least 1, for a queue message's delay. */
export function secondsUntil(dueAt: number, now: number): number {
  return Math.max(1, Math.ceil((dueAt - now) / SECOND));
}
