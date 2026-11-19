import { describe, expect, it } from "vitest";

import { uptimeResult, uptimeSignal } from "@/core/uptime-results";
import type { UptimeStreaks } from "@/core/uptime-results";

// Cases from the health CASE this replaces (UptimeMonitorStore.finish, before
// it moved to TypeScript).

function streaks(fields: Partial<UptimeStreaks> = {}): UptimeStreaks {
  return {
    health: "healthy",
    failures: 0,
    successes: 0,
    failureThreshold: 3,
    recoveryThreshold: 2,
    issueOpen: false,
    ...fields,
  };
}

describe("an uptime check", () => {
  it("degrades short of the failure threshold and fails at it", () => {
    expect(uptimeResult(streaks({ failures: 1 }), "failed")).toEqual({
      health: "degraded",
      failures: 2,
      successes: 0,
    });
    expect(uptimeResult(streaks({ failures: 2 }), "failed").health).toBe("failing");
  });

  it("stays failing short of the recovery streak, then recovers", () => {
    const failing = streaks({ health: "failing", failures: 3 });

    expect(uptimeResult(failing, "ok")).toEqual({ health: "failing", failures: 0, successes: 1 });
    expect(uptimeResult({ ...failing, successes: 1 }, "ok").health).toBe("healthy");
  });

  it("keeps failing while its issue is open, even after a gap reset the health", () => {
    expect(uptimeResult(streaks({ health: "unknown", issueOpen: true }), "failed").health).toBe(
      "failing",
    );
  });

  it("resets both streaks on an unknown check", () => {
    expect(uptimeResult(streaks({ failures: 2, successes: 1 }), "unknown")).toEqual({
      health: "unknown",
      failures: 0,
      successes: 0,
    });
  });
});

describe("an uptime check as an issue signal", () => {
  it("sights a failure, not a success short of recovery", () => {
    const failing = { health: "failing", failures: 0, successes: 1 } as const;

    expect(uptimeSignal(failing, "failed", 5)).toEqual({
      health: "failing",
      severity: "high",
      sighted: true,
      at: 5,
    });
    expect(uptimeSignal(failing, "ok", 5)?.sighted).toBe(false);
  });

  it("ignores degraded and unknown checks", () => {
    expect(uptimeSignal({ health: "degraded", failures: 1, successes: 0 }, "failed", 5)).toBeNull();
    expect(uptimeSignal({ health: "unknown", failures: 0, successes: 0 }, "unknown", 5)).toBeNull();
  });
});
