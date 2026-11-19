import { describe, expect, it } from "vitest";

import { approvedUptimeTarget } from "@/shared/uptime";

const APPROVED =
  "1=https://api.buck.cheap,1=https://buck.cheap,2=https://status.example.com/health";

function approved(url: string, organizationId = 1): boolean {
  return approvedUptimeTarget(new URL(url), organizationId, APPROVED);
}

describe("an uptime target", () => {
  it("may be any path on an approved origin", () => {
    expect(approved("https://api.buck.cheap/product/get")).toBe(true);
    expect(approved("https://buck.cheap/")).toBe(true);
  });

  it("may pass the endpoint arguments in its query string", () => {
    expect(
      approved("https://api.buck.cheap/product/get?id=1ae69b8a-5559-46cb-a9fb-816d2f914c04"),
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
      expect(approved(`https://api.buck.cheap/health?${name}=secret`)).toBe(false);
    }

    expect(approved("https://api.buck.cheap/health?id=1&credential=secret")).toBe(false);
  });

  it("may not carry credentials or a fragment", () => {
    expect(approved("https://user:pass@api.buck.cheap/health")).toBe(false);
    expect(approved("https://api.buck.cheap/health#top")).toBe(false);
  });

  it("is limited to its organization's origins, and an exact registration to its URL", () => {
    expect(approved("https://api.buck.cheap/health", 2)).toBe(false);
    expect(approved("https://status.example.com/health", 2)).toBe(true);
    expect(approved("https://status.example.com/other", 2)).toBe(false);
    expect(approved("https://evil.example.com/")).toBe(false);
  });
});
