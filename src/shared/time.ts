export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** Start of the hour containing `ms`. */
export function hourBucket(ms: number): number {
  return Math.floor(ms / HOUR) * HOUR;
}

/** Parses an ISO 8601 string to milliseconds, or null when it is not a date. */
export function parseIsoMs(text: string): number | null {
  const ms = Date.parse(text);

  return Number.isNaN(ms) ? null : ms;
}

/** Start of the UTC month containing `ms`. */
export function monthBucket(ms: number): number {
  const date = new Date(ms);

  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

/** Start of the UTC month after the one containing `ms`. */
export function nextMonthBucket(ms: number): number {
  const date = new Date(ms);

  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}
