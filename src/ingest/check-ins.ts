import { jsonText } from "@/shared/json";
import { CheckIn } from "@/shared/monitors";
import type { MonitorCheckIn } from "@/shared/monitors";

import { rateLimited, rejected } from "./http";

const WireCheckIn = jsonText(CheckIn);
const decoder = new TextDecoder();
const MAX_CHECK_IN_BYTES = 8 * 1024;

type CheckInDeps = {
  allowCheckIn: (key: string) => Promise<boolean>;
  recordCheckIn: (project: number, checkIn: MonitorCheckIn, now: number) => Promise<boolean>;
  now: () => number;
};

type Input = { bytes: Uint8Array; projectId: number; publicKey: string };

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

  if (!(await deps.allowCheckIn(input.publicKey))) {
    return rateLimited(60, { scope: "key", reason: "key_quota" }, "monitor");
  }

  const matched = await deps.recordCheckIn(input.projectId, parsed.data, deps.now());

  return matched ? undefined : rejected(404, "unknown or inactive cron monitor environment");
}
