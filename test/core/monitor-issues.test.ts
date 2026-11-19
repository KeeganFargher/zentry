import { describe, expect, it } from "vitest";

import { applySignal } from "@/core/monitor-issues";
import type { IssueState, Signal } from "@/shared/monitor-issues";

// Cases from the trigger chain this replaces (monitor_observation_issue and
// monitor_group_transition in migrations/0007_monitors.sql, before removal).

const NONE: IssueState = { issue: null, periodOpen: false };

function failing(fields: Partial<Signal> = {}): Signal {
  return { health: "failing", severity: "high", sighted: true, at: 1000, ...fields };
}

const HEALTHY: Signal = { health: "healthy", severity: null, sighted: false, at: 2000 };

function open(fields: Partial<NonNullable<IssueState["issue"]>> = {}): IssueState {
  return {
    issue: { status: "unresolved", level: "error", timesSeen: 1, ...fields },
    periodOpen: true,
  };
}

describe("a failing observation", () => {
  it("opens an issue, its period and a failure on first sight", () => {
    const { next, change } = applySignal(NONE, failing());

    expect(next).toEqual({
      issue: { status: "unresolved", level: "error", timesSeen: 1 },
      periodOpen: true,
    });
    expect(change).toEqual({
      createIssue: { level: "error" },
      activity: null,
      openPeriod: true,
      transition: { type: "failure", severity: "high" },
      closePeriod: false,
      update: { kind: "failing", level: "error", regressed: false, sighted: true },
    });
  });

  it("opens a medium issue as a warning", () => {
    const { change } = applySignal(NONE, failing({ severity: "medium" }));

    expect(change?.createIssue).toEqual({ level: "warning" });
    expect(change?.transition).toEqual({ type: "failure", severity: "medium" });
  });

  it("does not alert again while the issue stays open at the same level", () => {
    const { next, change } = applySignal(open({ timesSeen: 3 }), failing());

    expect(next.issue?.timesSeen).toBe(4);
    expect(change?.transition).toBeNull();
    expect(change?.openPeriod).toBe(false);
  });

  it("escalates an open warning to high", () => {
    const { change } = applySignal(open({ level: "warning" }), failing());

    expect(change?.transition).toEqual({ type: "escalation", severity: "high" });
  });

  it("does not escalate when a high issue drops to medium", () => {
    const { next, change } = applySignal(open(), failing({ severity: "medium" }));

    expect(next.issue?.level).toBe("warning");
    expect(change?.transition).toBeNull();
  });

  it("reopens a resolved issue as regressed, with a failure and a new period", () => {
    const state: IssueState = {
      issue: { status: "resolved", level: "error", timesSeen: 5 },
      periodOpen: false,
    };

    const { change } = applySignal(state, failing());

    expect(change).toMatchObject({
      createIssue: null,
      activity: "regressed",
      openPeriod: true,
      transition: { type: "failure", severity: "high" },
      update: { regressed: true },
    });
  });

  it("reopens an ignored issue with a failure but no regression", () => {
    const state: IssueState = {
      issue: { status: "ignored", level: "error", timesSeen: 2 },
      periodOpen: true,
    };

    const { change } = applySignal(state, failing());

    expect(change).toMatchObject({
      activity: null,
      transition: { type: "failure" },
      update: { regressed: false },
    });
  });

  it("does not count a success short of the recovery streak as a sighting", () => {
    const { next, change } = applySignal(open({ timesSeen: 2 }), failing({ sighted: false }));

    expect(next.issue?.timesSeen).toBe(2);
    expect(change?.update).toMatchObject({ sighted: false });
  });

  it("opens an issue without alerting when its first observation is not a sighting", () => {
    const { change } = applySignal(NONE, failing({ sighted: false }));

    expect(change?.createIssue).not.toBeNull();
    expect(change?.transition).toBeNull();
  });
});

describe("a healthy observation", () => {
  it("resolves an open issue, closes its period and recovers at the issue's severity", () => {
    const { next, change } = applySignal(open({ level: "warning" }), HEALTHY);

    expect(next).toEqual({
      issue: { status: "resolved", level: "warning", timesSeen: 1 },
      periodOpen: false,
    });
    expect(change).toEqual({
      createIssue: null,
      activity: "resolved",
      openPeriod: false,
      transition: { type: "recovery", severity: "medium" },
      closePeriod: true,
      update: { kind: "healthy" },
    });
  });

  it("changes nothing without an issue or an open period", () => {
    expect(applySignal(NONE, HEALTHY).change).toBeNull();
  });

  it("closes the period of an ignored issue without resolving or alerting", () => {
    const state: IssueState = {
      issue: { status: "ignored", level: "error", timesSeen: 1 },
      periodOpen: true,
    };

    const { next, change } = applySignal(state, HEALTHY);

    expect(next.issue?.status).toBe("ignored");
    expect(change).toMatchObject({
      activity: null,
      transition: null,
      closePeriod: true,
      update: null,
    });
  });
});

describe("a run of observations", () => {
  it("fails then recovers within one batch, with a transition for each", () => {
    const first = applySignal(NONE, failing());
    const second = applySignal(first.next, HEALTHY);

    expect([first.change?.transition?.type, second.change?.transition?.type]).toEqual([
      "failure",
      "recovery",
    ]);
  });
});
