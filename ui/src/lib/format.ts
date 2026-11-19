const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

type Unit = [size: number, short: string, long: string];

const UNITS: Unit[] = [
  [365 * DAY, "yr", "year"],
  [30 * DAY, "mo", "month"],
  [7 * DAY, "wk", "week"],
  [DAY, "d", "day"],
  [HOUR, "hr", "hour"],
  [MINUTE, "min", "minute"],
];

function largestUnit(elapsed: number): Unit | undefined {
  return UNITS.find(([size]) => elapsed >= size);
}

/** How long ago, in one unit: "5min", "3hr", "2wk", "7mo". Under a minute is "now". */
export function age(timestamp: number, now: number): string {
  const elapsed = Math.max(0, now - timestamp);
  const unit = largestUnit(elapsed);

  return unit === undefined ? "now" : `${Math.floor(elapsed / unit[0])}${unit[1]}`;
}

/** "5min ago", "3wk ago", or "just now", for lists. */
export function timeAgo(timestamp: number, now: number): string {
  const text = age(timestamp, now);

  return text === "now" ? "just now" : `${text} ago`;
}

/** "5 minutes", "an hour", "a few seconds": a span of time in words. */
export function duration(milliseconds: number): string {
  const elapsed = Math.max(0, milliseconds);
  const unit = largestUnit(elapsed);

  if (unit === undefined) {
    return elapsed < SECOND ? "less than a second" : "a few seconds";
  }

  const count = Math.floor(elapsed / unit[0]);

  if (count === 1) {
    return unit[2] === "hour" ? "an hour" : `a ${unit[2]}`;
  }

  return `${count} ${unit[2]}s`;
}

/** "5 minutes ago", "a few seconds ago", for the issue page. */
export function longAgo(timestamp: number, now: number): string {
  return `${duration(now - timestamp)} ago`;
}

export function dateTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** The same instant in UTC, for tooltips that show both. */
export function utcDateTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  });
}

export function shortDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function hourOfDay(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, { hour: "numeric" });
}

/** The span a chart bar covers: a day ("Nov 13, 2026") or an hour ("Nov 13, 2 PM – 3 PM"). */
export function bucketLabel(bucket: number, step: number): string {
  if (step >= DAY) {
    return new Date(bucket).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }

  return `${shortDate(bucket)}, ${hourOfDay(bucket)} – ${hourOfDay(bucket + step)}`;
}

/** "14:03", for timeline labels. */
export function minuteTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** "14:03:22.517", for breadcrumbs. */
export function clockTime(timestamp: number): string {
  const time = new Date(timestamp).toLocaleTimeString(undefined, { hour12: false });
  const millis = String(Math.floor(timestamp) % 1000).padStart(3, "0");

  return `${time}.${millis}`;
}

/** 1234 → "1.2K", 2500000 → "2.5M". */
export function compact(count: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(
    count,
  );
}

export function percent(part: number, whole: number): number {
  return whole === 0 ? 0 : Math.round((part / whole) * 100);
}

/**
 * A share as Sentry writes it: never "0%" for something that happened,
 * and never "100%" while anything else did.
 */
export function share(part: number, whole: number): string {
  if (whole === 0 || part === 0) {
    return "0%";
  }

  const exact = (part / whole) * 100;

  if (exact < 1) {
    return "<1%";
  }

  if (exact > 99 && part < whole) {
    return ">99%";
  }

  return `${Math.round(exact)}%`;
}

const BYTE_UNITS = ["B", "KiB", "MiB", "GiB", "TiB"];

/** 1536 → "1.5 KiB". */
export function bytes(count: number): string {
  let value = count;
  let unit = 0;

  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${unit === 0 ? value : value.toFixed(1)} ${BYTE_UNITS[unit] ?? "B"}`;
}
