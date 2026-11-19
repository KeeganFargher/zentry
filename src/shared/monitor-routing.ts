// Routing a monitor transition to its alert rules: the types shared by the
// pure rules (src/core/monitor-routing.ts) and the notify worker's reads and
// writes (src/db/monitor-routing.ts).

import type { NewMonitorRule } from "./monitor-alerts";
import type { TransitionType } from "./monitor-issues";

export type RoutedTransition = {
  type: TransitionType;
  severity: "medium" | "high";
  happenedAt: number;
  // The cron environment, or "" for a metric or uptime monitor's single scope.
  scope: string;
  periodId: number | null;
};

export type RoutedMonitor = {
  notify: boolean;
  status: "active" | "paused" | "archived";
  mutedUntil: number | null;
  // A metric or uptime monitor's configured environment, if it has one.
  environment: string | null;
};

export type LinkedRule = NewMonitorRule & { id: string };

/** An earlier delivery of the same issue that was sent, not suppressed. */
export type PriorDelivery = {
  ruleId: string;
  channel: "email" | "push";
  type: TransitionType;
  happenedAt: number;
  periodId: number | null;
};

export type Suppression =
  | "disabled"
  | "muted"
  | "rule_disabled"
  | "environment"
  | "priority"
  | "trigger"
  | "throttled";

export type Delivery = {
  ruleId: string;
  channel: "email" | "push";
  // The transition as this rule sees it (see `effectiveType`).
  type: TransitionType;
  suppression: Suppression | null;
};

/** What routing one transition reads. */
export type RoutingInput = {
  transition: RoutedTransition;
  monitor: RoutedMonitor;
  priors: PriorDelivery[];
  rules: LinkedRule[];
  // The scope's issue; null if it was deleted, and then nothing is delivered.
  groupId: number | null;
};
