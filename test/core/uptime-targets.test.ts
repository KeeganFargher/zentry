import { describe, expect, it } from "vitest";

import { productionUptimeTarget, secretFreeUptimeTarget } from "@/shared/uptime";

function accepted(url: string): boolean {
  const target = new URL(url);

  return secretFreeUptimeTarget(target) && productionUptimeTarget(target);
}

describe("an uptime target", () => {
  it("may be any public HTTPS URL, with no allowlist", () => {
    expect(accepted("https://api.buck.cheap/product/get")).toBe(true);
    expect(accepted("https://status.example.com/health")).toBe(true);
    expect(accepted("https://anything.new.example.org/")).toBe(true);
  });

  it("may pass the endpoint arguments in its query string", () => {
    expect(
      accepted("https://api.buck.cheap/product/get?id=1ae69b8a-5559-46cb-a9fb-816d2f914c04"),
    ).toBe(true);
  });

  it("may not carry a parameter named like a credential", () => {
    for (const name of [
      "token",
      "api_key",
      "apiKey",
      "access-key",
      "password",
      "session",
      "auth",
    ]) {
      expect(accepted(`https://api.buck.cheap/health?${name}=secret`)).toBe(false);
    }

    expect(accepted("https://api.buck.cheap/health?id=1&credential=secret")).toBe(false);
  });

  it("may not carry credentials or a fragment", () => {
    expect(accepted("https://user:pass@api.buck.cheap/health")).toBe(false);
    expect(accepted("https://api.buck.cheap/health#top")).toBe(false);
  });

  // Without an allowlist these are what keep a probe off internal addresses.
  it("must be HTTPS on the default port to a DNS name", () => {
    expect(accepted("http://status.example.com/")).toBe(false);
    expect(accepted("https://status.example.com:8443/")).toBe(false);
    expect(accepted("https://10.0.0.1/")).toBe(false);
    expect(accepted("https://[::1]/")).toBe(false);
    expect(accepted("https://localhost/")).toBe(false);
  });
});
