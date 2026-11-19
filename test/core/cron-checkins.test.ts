import { describe, expect, it } from "vitest";

import { firstReport, laterReport, missedSlots, timedOut } from "@/core/cron-checkins";
import type { Change } from "@/core/cron-checkins";
import { NEW_ENVIRONMENT } from "@/shared/cron";
import type { CheckInRow, EnvironmentState } from "@/shared/cron";
import { CronConfig } from "@/shared/monitors";
import { MINUTE } from "@/shared/time";

const T0 = Date.parse("2026-11-19T02:00:00Z");

const hourly = CronConfig.parse({
  slug: "export",
  schedule: { type: "crontab", crontab: "0 * * * *" },
  graceMinutes: 3,
  maxRuntimeMinutes: 20,
});

/** The change's row, which these steps always write. */
function rowOf(change: Change): CheckInRow {
  if (change.row === null) {
    throw new Error("expected the change to write a row");
  }

  return change.row;
}

let ids = 0;
const newId = (): string => `missed-${(ids += 1)}`;

function start(environment: EnvironmentState, at: number, id = `run-${at}`) {
  return firstReport(hourly, environment, {
    checkInId: id,
    status: "in_progress",
    durationMs: null,
    now: at,
  });
}

function finish(
  environment: EnvironmentState,
  run: { row: CheckInRow; status: "ok" | "error"; at: number },
) {
  return laterReport(hourly, environment, {
    row: run.row,
    status: run.status,
    durationMs: null,
    now: run.at,
  });
}

describe("check-ins", () => {
  it("records every check-in and moves the schedule from its start", () => {
    // The spec's example: a 02:00 job with three minutes of grace starts at 02:02.
    const started = start(NEW_ENVIRONMENT, T0 + 2 * MINUTE);

    expect(started.row).toMatchObject({ status: "in_progress", timeoutAt: T0 + 22 * MINUTE });
    expect(started.environment.nextCheckIn).toBe(T0 + 60 * MINUTE);
    expect(started.environment.nextCheckInLatest).toBe(T0 + 63 * MINUTE);
    expect(started.decision).toBeNull();

    const done = finish(started.environment, {
      row: rowOf(started),
      status: "ok",
      at: T0 + 10 * MINUTE,
    });

    expect(done.row).toMatchObject({ status: "ok", durationMs: 8 * MINUTE });
    expect(done.decision).toMatchObject({ outcome: "ok", health: "healthy" });
  });

  it("keeps a heartbeat that arrives long after its expected time", () => {
    // A job that only reports when it ends, ten minutes after it started.
    const armed = firstReport(hourly, NEW_ENVIRONMENT, {
      checkInId: "a",
      status: "ok",
      durationMs: null,
      now: T0,
    });

    const late = firstReport(hourly, armed.environment, {
      checkInId: "b",
      status: "ok",
      durationMs: 600_000,
      now: T0 + 70 * MINUTE,
    });

    expect(late.row).toMatchObject({
      status: "ok",
      expectedAt: T0 + 60 * MINUTE,
      durationMs: 600_000,
    });
    expect(late.environment.nextCheckIn).toBe(T0 + 120 * MINUTE);
    expect(late.decision?.health).toBe("healthy");
  });

  it("ignores reports for a finished run", () => {
    const started = start(NEW_ENVIRONMENT, T0);

    const done = finish(started.environment, {
      row: rowOf(started),
      status: "ok",
      at: T0 + MINUTE,
    });

    const again = finish(done.environment, {
      row: rowOf(done),
      status: "error",
      at: T0 + 2 * MINUTE,
    });

    expect(again.row).toBeNull();
  });

  it("extends the deadline of a run that reports in progress again", () => {
    const started = start(NEW_ENVIRONMENT, T0);

    const beat = laterReport(hourly, started.environment, {
      row: rowOf(started),
      status: "in_progress",
      durationMs: null,
      now: T0 + 15 * MINUTE,
    });

    expect(beat.row?.timeoutAt).toBe(T0 + 35 * MINUTE);
  });
});

describe("failures and recovery", () => {
  const strict = CronConfig.parse({ ...hourly, failureThreshold: 2, recoveryThreshold: 2 });

  it("opens after the failure threshold and recovers after the recovery threshold", () => {
    const report = (environment: EnvironmentState, status: "ok" | "error", at: number) =>
      firstReport(strict, environment, { checkInId: `r${at}`, status, durationMs: null, now: at });

    const one = report(NEW_ENVIRONMENT, "error", T0);
    expect(one.decision?.health).toBe("degraded");

    const two = report(one.environment, "error", T0 + 60 * MINUTE);
    expect(two.decision?.health).toBe("failing");

    const three = report(two.environment, "ok", T0 + 120 * MINUTE);
    expect(three.decision?.health).toBe("failing");

    const four = report(three.environment, "ok", T0 + 180 * MINUTE);
    expect(four.decision?.health).toBe("healthy");
  });

  it("lets an older run's late result be recorded without undoing a newer one", () => {
    const first = start(NEW_ENVIRONMENT, T0, "first");
    const second = start(first.environment, T0 + 60 * MINUTE, "second");

    const secondDone = finish(second.environment, {
      row: rowOf(second),
      status: "ok",
      at: T0 + 61 * MINUTE,
    });

    const firstDone = finish(secondDone.environment, {
      row: rowOf(first),
      status: "error",
      at: T0 + 62 * MINUTE,
    });

    expect(firstDone.row?.status).toBe("error");
    expect(firstDone.decision).toBeNull();
    expect(firstDone.environment.failures).toBe(0);
    expect(firstDone.environment.nextCheckIn).toBe(T0 + 120 * MINUTE);
  });
});

describe("missed and timed-out runs", () => {
  it("records nothing before the first check-in", () => {
    const missed = missedSlots(hourly, NEW_ENVIRONMENT, {
      now: T0 + 24 * 60 * MINUTE,
      limit: 10,
      newId,
    });

    expect(missed.rows).toEqual([]);
  });

  it("records one missed row per expected slot, backdated to it", () => {
    const armed = start(NEW_ENVIRONMENT, T0);
    const done = finish(armed.environment, { row: rowOf(armed), status: "ok", at: T0 + MINUTE });

    // Three hourly slots pass with no check-in.
    const missed = missedSlots(hourly, done.environment, {
      now: T0 + 183 * MINUTE,
      limit: 10,
      newId,
    });

    expect(missed.rows.map(({ expectedAt }) => expectedAt)).toEqual([
      T0 + 60 * MINUTE,
      T0 + 120 * MINUTE,
      T0 + 180 * MINUTE,
    ]);
    expect(
      missed.rows.every(
        ({ status, dateAdded, expectedAt }) => status === "missed" && dateAdded === expectedAt,
      ),
    ).toBe(true);
    expect(missed.environment.nextCheckIn).toBe(T0 + 240 * MINUTE);
    expect(missed.decisions.at(-1)?.health).toBe("failing");
  });

  it("waits for the margin before calling a check-in missed", () => {
    const armed = firstReport(hourly, NEW_ENVIRONMENT, {
      checkInId: "a",
      status: "ok",
      durationMs: null,
      now: T0,
    });

    expect(
      missedSlots(hourly, armed.environment, { now: T0 + 62 * MINUTE, limit: 10, newId }).rows,
    ).toEqual([]);
    expect(
      missedSlots(hourly, armed.environment, { now: T0 + 63 * MINUTE, limit: 10, newId }).rows,
    ).toHaveLength(1);
  });

  it("caps the slots one call catches up", () => {
    const armed = firstReport(hourly, NEW_ENVIRONMENT, {
      checkInId: "a",
      status: "ok",
      durationMs: null,
      now: T0,
    });

    const missed = missedSlots(hourly, armed.environment, {
      now: T0 + 48 * 60 * MINUTE,
      limit: 10,
      newId,
    });

    expect(missed.rows).toHaveLength(10);
    expect(missed.environment.nextCheckIn).toBe(T0 + 11 * 60 * MINUTE);
  });

  it("times out a run past its runtime and keeps the timeout when it finishes late", () => {
    const started = start(NEW_ENVIRONMENT, T0);
    const timeout = timedOut(hourly, started.environment, rowOf(started));

    expect(timeout.row?.status).toBe("timeout");
    expect(timeout.decision).toMatchObject({ outcome: "timeout", health: "failing" });

    const late = finish(timeout.environment, {
      row: rowOf(timeout),
      status: "ok",
      at: T0 + 25 * MINUTE,
    });

    expect(late.row).toMatchObject({
      status: "timeout",
      completedAt: T0 + 25 * MINUTE,
      durationMs: 25 * MINUTE,
    });
    expect(late.decision).toBeNull();
  });
});
