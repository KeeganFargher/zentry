// From ui/src/lib/clock.ts, also refreshed on subscribe for a phone app
// that spends time in the background.
// A shared minute clock, so every relative time on the page moves together
// and "5min ago" does not go stale while the page stays open.

import { useSyncExternalStore } from "react";

const TICK = 60_000;

let now = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  // Timers stop while the app is in the background, so a screen shown again
  // starts from the time now, not when the clock last ticked.
  now = Date.now();

  if (timer === null) {
    timer = setInterval(() => {
      now = Date.now();

      for (const notify of listeners) {
        notify();
      }
    }, TICK);
  }

  return () => {
    listeners.delete(listener);

    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** The current time, refreshed once a minute. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, () => now);
}
