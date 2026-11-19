import { describe, expect, it } from "vitest";

import probe from "@/uptime-probe";

// Only the policy guard runs here: every case is refused before the probe
// would fetch, so no network is needed. Real requests are covered by e2e.
const env = {
  FIXTURE_ORIGIN: "",
  UPTIME_PROBES_PAUSED: "0",
  UPTIME_BLOCKED_HOSTS: "zentry.example.com,ingest.example.com",
  DESTINATION_RL: { limit: async () => ({ success: false }) },
};

async function reason(url: string): Promise<string | undefined> {
  // Typed as an incoming request, which is what a service binding delivers.
  const request = new Request<unknown, IncomingRequestCfProperties>(
    "https://uptime-probe.internal/",
    {
      method: "POST",
      body: JSON.stringify({ url, method: "GET", timeoutMs: 5000 }),
    },
  );

  const response = await probe.fetch(request, env);

  return (await response.json<{ reason?: string }>()).reason;
}

describe("the uptime probe's guard", () => {
  it("refuses Zentry's blocked hosts, plain HTTP, IP literals and secrets", async () => {
    for (const url of [
      "https://zentry.example.com/",
      "https://ingest.example.com/health",
      "http://status.example.org/",
      "https://10.0.0.1/",
      "https://user:pass@status.example.org/",
      "https://status.example.org/?api_key=secret",
    ]) {
      expect(await reason(url)).toBe("policy");
    }
  });

  // The destination budget is checked after the policy, so reaching it shows
  // any public URL passes without an allowlist.
  it("lets any public HTTPS URL through to the destination budget", async () => {
    expect(await reason("https://status.brand-new-site.example/health")).toBe("budget");
  });
});
