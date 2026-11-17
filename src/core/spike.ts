// Spike protection thresholds (DESIGN.md §6). A reduced form of Sentry's
// algorithm, as described in its docs (docs/pricing/quotas/spike-protection.mdx
// in getsentry/sentry-docs; the code itself lives in the closed getsentry repo):
// the hourly threshold is the higher of a floor derived from the monthly quota
// and a projection of the last 168 hours times a variability multiplier.

/** Hours of history the projection looks at: one week, as in Sentry. */
export const SPIKE_HISTORY_HOURS = 168;

const HOURS_PER_DAY = 24;

/**
 * 1/10 of the smallest error quota Sentry sells (5,000 a month on Developer),
 * Sentry's own lower bound, so a tiny project is not flagged on a handful of
 * errors.
 */
const MIN_FLOOR_PER_HOUR = 500;

/** Sentry caps the project count in the floor formula at 5. */
const MAX_PROJECTS_IN_FLOOR = 5;

/** A month of hours, as in Sentry's `3 × quota / (720 × projects)`. */
const HOURS_PER_MONTH = 720;

const MIN_MULTIPLIER = 3;
const MAX_MULTIPLIER = 6;

/**
 * The lowest threshold any project gets. `3 × quota / (720 × projects)` is the
 * hourly rate at which a project would use three months of quota in one month.
 */
export function spikeFloor(maxEventsPerMonth: number, projectCount: number): number {
  const projects = Math.min(Math.max(projectCount, 1), MAX_PROJECTS_IN_FLOOR);

  return Math.max(
    MIN_FLOOR_PER_HOUR,
    Math.ceil((3 * maxEventsPerMonth) / (HOURS_PER_MONTH * projects)),
  );
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Sentry multiplies by "5 times the standard deviation", bounded to 3..6. A
 * raw standard deviation has the unit of the counts, so it is taken relative
 * to the mean here (the coefficient of variation): steady traffic gets 3x,
 * traffic that already swings a lot gets up to 6x.
 */
function multiplier(hours: number[], average: number): number {
  if (average === 0) {
    return MIN_MULTIPLIER;
  }

  const variance = mean(hours.map((count) => (count - average) ** 2));
  const variation = Math.sqrt(variance) / average;

  return Math.min(MAX_MULTIPLIER, Math.max(MIN_MULTIPLIER, 5 * variation));
}

/**
 * The threshold for the hour that follows `hours`.
 *
 * `hours` holds the accepted count of each of the last 168 complete hours,
 * oldest first, zeros included. The projection is the higher of the weekly mean
 * and the mean of the same hour of day on each of the 7 days, which stands in
 * for Sentry's seasonality weighting: a daily peak is not mistaken for a spike.
 *
 * Only accepted events are counted, because refused ones never reach the
 * consumer. Sentry gives dropped events a decaying weight; here they weigh
 * nothing, so a long spike raises the threshold more slowly than in Sentry.
 */
export function spikeThreshold(hours: number[], floor: number): number {
  if (hours.length !== SPIKE_HISTORY_HOURS) {
    throw new Error(`spike history must be ${SPIKE_HISTORY_HOURS} hours, got ${hours.length}`);
  }

  const average = mean(hours);
  // The next hour is index 168, so the same hour on earlier days is 144, 120, … 0.
  const sameHour = mean(hours.filter((_, index) => index % HOURS_PER_DAY === 0));
  const projection = Math.max(average, sameHour);

  return Math.max(floor, Math.ceil(projection * multiplier(hours, average)));
}
