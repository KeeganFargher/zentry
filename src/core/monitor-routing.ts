// Which of a monitor's linked alert rules hear about a transition, on which
// channels, and why each one that does not is suppressed. Pure; the notify
// worker reads the inputs and writes one delivery row per rule and channel
// (src/notify/monitor-routing.ts).

import type { TransitionType } from "@/shared/monitor-issues";
import type {
  Delivery,
  LinkedRule,
  PriorDelivery,
  RoutedMonitor,
  RoutedTransition,
  Suppression,
} from "@/shared/monitor-routing";

export type Context = {
  transition: RoutedTransition;
  monitor: RoutedMonitor;
  priors: PriorDelivery[];
};

type Target = { rule: LinkedRule; channel: Delivery["channel"] };

function priorsFor({ priors }: Context, { rule, channel }: Target): PriorDelivery[] {
  return priors.filter((prior) => prior.ruleId === rule.id && prior.channel === channel);
}

/**
 * For a rule that pages only on high priority, the first escalation to high in
 * an incident is that rule's failure: it has not heard of this incident yet.
 */
function effectiveType(context: Context, target: Target): TransitionType {
  const { transition } = context;

  const heard = priorsFor(context, target).some(({ periodId }) => periodId === transition.periodId);

  return target.rule.priority === "high" && transition.type === "escalation" && !heard
    ? "failure"
    : transition.type;
}

/** Whether this rule already paged on this channel in the incident a recovery ends. */
function paged(context: Context, target: Target): boolean {
  return priorsFor(context, target).some(
    ({ type, periodId }) => type !== "recovery" && periodId === context.transition.periodId,
  );
}

function monitorSuppression({ transition, monitor }: Context): Suppression | null {
  if (!monitor.notify || monitor.status !== "active") {
    return "disabled";
  }

  // A mute covers what happened before it ends, so a failure while muted stays
  // silent even if the worker routes it after the mute ran out. The monitor's
  // settings are read when the worker routes (usually within the minute): an
  // explicit unmute, a pause or a newly linked rule before then applies.
  if (monitor.mutedUntil !== null && monitor.mutedUntil > transition.happenedAt) {
    return "muted";
  }

  return null;
}

function priorityMisses(context: Context, target: Target): boolean {
  const { transition } = context;

  if (target.rule.priority !== "high") {
    return false;
  }

  // A high-priority rule hears high failures, and a recovery only if it paged.
  return transition.type === "recovery" ? !paged(context, target) : transition.severity !== "high";
}

/**
 * A repeat of the same transition inside the rule's throttle is held back.
 * Recovery never is: a throttled recovery would leave "failing" as the last
 * thing anyone was told.
 */
function throttled(context: Context, target: Target, type: TransitionType): boolean {
  const since = context.transition.happenedAt - target.rule.throttleSeconds * 1000;

  return (
    type !== "recovery" &&
    priorsFor(context, target).some((prior) => prior.type === type && prior.happenedAt > since)
  );
}

function ruleSuppression(
  context: Context,
  target: Target,
  type: TransitionType,
): Suppression | null {
  const { rule } = target;

  const environment =
    context.transition.scope === "" ? context.monitor.environment : context.transition.scope;

  if (!rule.enabled) {
    return "rule_disabled";
  }

  if (rule.environment !== undefined && rule.environment !== environment) {
    return "environment";
  }

  if (priorityMisses(context, target)) {
    return "priority";
  }

  if (!rule.triggers.includes(type)) {
    return "trigger";
  }

  return throttled(context, target, type) ? "throttled" : null;
}

/** One delivery per linked rule and channel, each sent or suppressed with its reason. */
export function routeTransition(context: Context, rules: LinkedRule[]): Delivery[] {
  const held = monitorSuppression(context);

  return rules.flatMap((rule) =>
    rule.channels.map((channel) => {
      const target = { rule, channel };
      const type = effectiveType(context, target);

      return {
        ruleId: rule.id,
        channel,
        type,
        suppression: held ?? ruleSuppression(context, target, type),
      };
    }),
  );
}
