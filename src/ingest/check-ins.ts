import { jsonText } from "@/shared/json";
import { CheckIn } from "@/shared/monitors";
import type { MonitorCheckIn } from "@/shared/monitors";

import { rateLimited, rejected } from "./http";

const WireCheckIn = jsonText(CheckIn);
const decoder = new TextDecoder();
const MAX_CHECK_IN_BYTES = 8 * 1024;

type CheckInDeps = {
  /** The DSN key's ingest burst limit, which check-ins spend as events do. */
  allow: (publicKey: string) => Promise<boolean>;
  /** Sentry's per-monitor-environment check-in rate limit. */
  allowCheckIn: (key: string) => Promise<boolean>;
  recordCheckIn: (project: number, checkIn: MonitorCheckIn, now: number) => Promise<void>;
  now: () => number;
};

type Input = { bytes: Uint8Array; projectId: number; publicKey: string };

/**
 * Accepts one `check_in` item. Undefined means it was taken: as with Relay,
 * a check-in for an unknown or paused monitor is still accepted (and counted
 * for the UI), because an SDK only logs an error response and would keep
 * sending.
 */
export async function acceptCheckIn(
  input: Input,
  deps: CheckInDeps,
): Promise<Response | undefined> {
  if (input.bytes.length > MAX_CHECK_IN_BYTES) {
    return rejected(413, "check-in too large");
  }

  const parsed = WireCheckIn.safeParse(decoder.decode(input.bytes));

  if (!parsed.success) {
    return rejected(400, "invalid check-in");
  }

  const { slug, environment } = parsed.data;

  // The key limit bounds a client that rotates slugs or environments, which
  // the per-monitor limit alone would let through.
  if (!(await deps.allow(input.publicKey))) {
    return rateLimited(60, { scope: "key", reason: "key_quota" }, "monitor");
  }

  if (!(await deps.allowCheckIn(`${input.projectId}:${slug}:${environment}`))) {
    return rateLimited(60, { scope: "key", reason: "monitor_rate_limit" }, "monitor");
  }

  await deps.recordCheckIn(input.projectId, parsed.data, deps.now());

  return undefined;
}
