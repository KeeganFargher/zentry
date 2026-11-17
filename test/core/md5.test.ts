import { describe, expect, it } from "vitest";

import { md5Hex } from "@/core/md5";

describe("md5Hex", () => {
  it("matches the RFC 1321 test vectors", () => {
    expect(md5Hex("")).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(md5Hex("abc")).toBe("900150983cd24fb0d6963f7d28e17f72");
    expect(md5Hex("message digest")).toBe("f96b697d7cb7938d525a2f31aaf161d0");

    expect(
      md5Hex("12345678901234567890123456789012345678901234567890123456789012345678901234567890"),
    ).toBe("57edf4a22be3c955ac49da2e2107b67a");
  });

  it("hashes multi-byte text as UTF-8", () => {
    expect(md5Hex("héllo")).toBe("be50e8478cf24ff3595bc7307fb91b50");
  });
});
