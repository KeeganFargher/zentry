import { describe, expect, it } from "vitest";

import { routeTransition } from "@/core/monitor-routing";
import type {
  LinkedRule,
  PriorDelivery,
  RoutedMonitor,
  RoutedTransition,
} from "@/shared/monitor-routing";

// Cases from the trigger this replaces (monitor_transition_deliver in
// migrations/0007_monitors.sql, before removal).

const MINUTE = 60_000;

const MONITOR: RoutedMonitor = {
  notify: true,
  status: "active",
  mutedUntil: null,
  environment: null,
};

function transition(fields: Partial<RoutedTransition> = {}): RoutedTransition {
  return {
    type: "failure",
    severity: "high",
    happenedAt: 100 * MINUTE,
    scope: "production",
    periodId: 7,
    ...fields,
  };
}

function rule(fields: Partial<LinkedRule> = {}): LinkedRule {
  return {
    id: "rule",
    name: "On-call",
    enabled: true,
    channels: ["email"],
    triggers: ["failure", "escalation", "recovery"],
    throttleSeconds: 300,
    audience: { kind: "project" },
    ...fields,
  };
}

function route(
  fields: { transition?: RoutedTransition; monitor?: RoutedMonitor; priors?: PriorDelivery[] },
  rules: LinkedRule[] = [rule()],
) {
  return routeTransition(
    {
      transition: fields.transition ?? transition(),
      monitor: fields.monitor ?? MONITOR,
      priors: fields.priors ?? [],
    },
    rules,
  );
}

function prior(fields: Partial<PriorDelivery> = {}): PriorDelivery {
  return {
    ruleId: "rule",
    channel: "email",
    type: "failure",
    happenedAt: 99 * MINUTE,
    periodId: 7,
    ...fields,
  };
}

describe("routing a transition", () => {
  it("delivers on every channel of every linked rule", () => {
    const deliveries = route({}, [rule({ channels: ["email", "push"] }), rule({ id: "other" })]);

    expect(deliveries).toEqual([
      { ruleId: "rule", channel: "email", type: "failure", suppression: null },
      { ruleId: "rule", channel: "push", type: "failure", suppression: null },
      { ruleId: "other", channel: "email", type: "failure", suppression: null },
    ]);
  });

  it("suppresses everything for a monitor with notifications off or not active", () => {
    expect(route({ monitor: { ...MONITOR, notify: false } })[0]?.suppression).toBe("disabled");
    expect(route({ monitor: { ...MONITOR, status: "paused" } })[0]?.suppression).toBe("disabled");
  });

  it("judges a mute at the transition's time", () => {
    const muted = { ...MONITOR, mutedUntil: 101 * MINUTE };

    expect(route({ monitor: muted })[0]?.suppression).toBe("muted");
    expect(
      route({ monitor: muted, transition: transition({ happenedAt: 102 * MINUTE }) })[0]
        ?.suppression,
    ).toBeNull();
  });

  it("suppresses a disabled rule, another environment and an unwanted trigger", () => {
    expect(route({}, [rule({ enabled: false })])[0]?.suppression).toBe("rule_disabled");
    expect(route({}, [rule({ environment: "staging" })])[0]?.suppression).toBe("environment");
    expect(route({}, [rule({ triggers: ["recovery"] })])[0]?.suppression).toBe("trigger");
  });

  it("matches a rule's environment against the monitor's own for an unscoped transition", () => {
    const monitor = { ...MONITOR, environment: "production" };

    expect(
      route({ monitor, transition: transition({ scope: "" }) }, [
        rule({ environment: "production" }),
      ])[0]?.suppression,
    ).toBeNull();
  });

  it("throttles a repeat of the same transition inside the rule's window", () => {
    expect(route({ priors: [prior()] })[0]?.suppression).toBe("throttled");
    expect(route({ priors: [prior({ happenedAt: 90 * MINUTE })] })[0]?.suppression).toBeNull();
  });

  it("never throttles a recovery", () => {
    const deliveries = route({
      transition: transition({ type: "recovery" }),
      priors: [prior({ type: "recovery" })],
    });

    expect(deliveries[0]?.suppression).toBeNull();
  });
});

describe("a high-priority rule", () => {
  const high = rule({ priority: "high" });

  it("ignores a medium failure", () => {
    expect(route({ transition: transition({ severity: "medium" }) }, [high])[0]?.suppression).toBe(
      "priority",
    );
  });

  it("hears the first escalation to high in an incident as its failure", () => {
    const deliveries = route({ transition: transition({ type: "escalation" }) }, [high]);

    expect(deliveries[0]).toMatchObject({ type: "failure", suppression: null });
  });

  it("hears a later escalation as an escalation once it has paged in the incident", () => {
    const deliveries = route(
      { transition: transition({ type: "escalation" }), priors: [prior({ happenedAt: 0 })] },
      [high],
    );

    expect(deliveries[0]).toMatchObject({ type: "escalation", suppression: null });
  });

  it("sends a recovery only for an incident it paged", () => {
    const recovery = transition({ type: "recovery" });

    expect(route({ transition: recovery }, [high])[0]?.suppression).toBe("priority");
    expect(route({ transition: recovery, priors: [prior()] }, [high])[0]?.suppression).toBeNull();
    expect(
      route({ transition: recovery, priors: [prior({ periodId: 6 })] }, [high])[0]?.suppression,
    ).toBe("priority");
  });
});
