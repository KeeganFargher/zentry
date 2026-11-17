import { describe, expect, it } from "vitest";

import { parameterize } from "@/core/parameterize";

describe("parameterize", () => {
  it.each([
    ["User 12345 not found", "User <int> not found"],
    ["took 1.5s to load", "took <duration> to load"],
    ["timeout after 300ms", "timeout after <duration>"],
    ["mail to bob@example.com failed", "mail to <email> failed"],
    ["GET https://api.example.com/v1/users?id=4 failed", "GET <url> failed"],
    ["order 3f2b8c1e-9d4a-4c6b-8e1f-0a2b3c4d5e6f missing", "order <uuid> missing"],
    ["commit 356a192b7913b04c54574d18c28d46e6395428ab", "commit <hash>"],
    ["etag d41d8cd98f00b204e9800998ecf8427e", "etag <hash>"],
    ["at 2026-11-17T10:22:33.123Z", "at <date>"],
    ["from 192.168.1.20", "from <ip>"],
    ["pointer 0x7ffe12ab", "pointer <hex>"],
    ["ratio 0.75 exceeded", "ratio <float> exceeded"],
    [
      "Cannot read properties of undefined (reading 'name')",
      "Cannot read properties of undefined (reading 'name')",
    ],
  ])("%s", (input, expected) => {
    expect(parameterize(input)).toBe(expected);
  });

  it("keeps only the first line", () => {
    expect(parameterize("first 1\nsecond 2")).toBe("first <int>");
  });
});
