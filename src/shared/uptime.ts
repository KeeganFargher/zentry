import { z } from "zod";

export const ProbeResponse = z.object({
  outcome: z.enum(["ok", "failed", "unknown"]),
  httpStatus: z.int().optional(),
  durationMs: z.int().nonnegative().optional(),
  reason: z.enum(["policy", "timeout", "network", "status", "budget", "paused"]).optional(),
});

/** Registrations authorize a canonical origin or one exact path by organization. */
export function approvedUptimeTarget(
  target: URL,
  organizationId: number,
  approvedOrigins: string,
): boolean {
  if (
    target.username !== "" ||
    target.password !== "" ||
    target.hash !== "" ||
    target.search !== ""
  ) {
    return false;
  }

  const allowed = approvedOrigins.split(",");

  return (
    allowed.includes(`${organizationId}=${target.origin}`) ||
    allowed.includes(`${organizationId}=${target.href}`)
  );
}

export function productionUptimeTarget(target: URL): boolean {
  return (
    target.protocol === "https:" &&
    target.port === "" &&
    /^(?:[a-z0-9-]+\.)+[a-z](?:[a-z0-9-]*[a-z0-9])?$/.test(target.hostname)
  );
}
