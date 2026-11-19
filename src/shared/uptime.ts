import { z } from "zod";

import { isSensitiveKey } from "./sensitive";

export const ProbeResponse = z.object({
  outcome: z.enum(["ok", "failed", "unknown"]),
  httpStatus: z.int().optional(),
  durationMs: z.int().nonnegative().optional(),
  reason: z.enum(["policy", "timeout", "network", "status", "budget", "paused"]).optional(),
});

/**
 * A query string may pass an endpoint its arguments (`?id=…`), but no
 * parameter may be named like a credential: the URL is stored in the
 * monitor's settings and shown in the UI, so a token in it would leak.
 */
function credentialFree(target: URL): boolean {
  return [...target.searchParams.keys()].every((name) => !isSensitiveKey(name));
}

/**
 * Any URL a member types is accepted, without an operator allowlist: an
 * allowlist in deploy config made every new endpoint a redeploy. What keeps a
 * probe from becoming a way into Zentry or a leak instead is that the target
 * must be public HTTPS (productionUptimeTarget), never one of Zentry's own
 * hosts (checked by the callers), and carry no secrets, because the URL is
 * stored in the monitor's settings and shown in the UI.
 */
export function secretFreeUptimeTarget(target: URL): boolean {
  return (
    target.username === "" && target.password === "" && target.hash === "" && credentialFree(target)
  );
}

/**
 * The end-to-end suite's shop fixture, which is served over plain HTTP. It is
 * configured explicitly (UPTIME_FIXTURE_ORIGIN, FIXTURE_ORIGIN) and accepted
 * only on a loopback host, so a production setting cannot open plain HTTP to
 * a real address.
 */
export function fixtureTarget(target: URL, fixtureOrigin: string): boolean {
  return (
    fixtureOrigin !== "" &&
    target.origin === fixtureOrigin &&
    (target.hostname === "localhost" || target.hostname === "127.0.0.1")
  );
}

export function productionUptimeTarget(target: URL): boolean {
  return (
    target.protocol === "https:" &&
    target.port === "" &&
    /^(?:[a-z0-9-]+\.)+[a-z](?:[a-z0-9-]*[a-z0-9])?$/.test(target.hostname)
  );
}
