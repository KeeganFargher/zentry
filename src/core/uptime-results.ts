// An uptime check's effect on its monitor's streaks and health, and how the
// issue lifecycle (src/core/monitor-issues.ts) reads it.

import type { Signal } from "@/shared/monitor-issues";

export type UptimeStreaks = {
  health: string;
  failures: number;
  successes: number;
  failureThreshold: number;
  recoveryThreshold: number;
  // Whether the monitor's issue is open: a failure then keeps it failing.
  issueOpen: boolean;
};

export type UptimeOutcome = "ok" | "failed" | "unknown";

export type UptimeResult = {
  health: "unknown" | "failing" | "healthy" | "degraded";
  failures: number;
  successes: number;
};

/**
 * Consecutive failures reach the failure threshold to fail, and consecutive
 * successes the recovery threshold to recover. Short of either, an incident
 * that is open stays failing; otherwise the monitor is degraded. An unknown
 * check (a coverage gap, the probe unavailable) resets both streaks.
 */
export function uptimeResult(streaks: UptimeStreaks, outcome: UptimeOutcome): UptimeResult {
  const failures = outcome === "failed" ? streaks.failures + 1 : 0;
  const successes = outcome === "ok" ? streaks.successes + 1 : 0;

  if (outcome === "unknown") {
    return { health: "unknown", failures, successes };
  }

  if (outcome === "failed" && failures >= streaks.failureThreshold) {
    return { health: "failing", failures, successes };
  }

  if (outcome === "ok" && successes >= streaks.recoveryThreshold) {
    return { health: "healthy", failures, successes };
  }

  const stillFailing = streaks.health === "failing" || streaks.issueOpen;

  return { health: stillFailing ? "failing" : "degraded", failures, successes };
}

/** The check as an observation of the monitor's issue; a success short of recovery is not a sighting. */
export function uptimeSignal(
  result: UptimeResult,
  outcome: UptimeOutcome,
  at: number,
): Signal | null {
  if (result.health === "failing") {
    return { health: "failing", severity: "high", sighted: outcome !== "ok", at };
  }

  return result.health === "healthy"
    ? { health: "healthy", severity: null, sighted: false, at }
    : null;
}
