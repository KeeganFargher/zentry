import { describe, expect, it } from "vitest";

import { computeHash } from "@/core/grouping";
import { md5Hex } from "@/core/md5";

import { normalize, pythonError } from "./helpers";

const frame = { filename: "app/views.py", function: "checkout", lineno: 42 };

describe("computeHash", () => {
  it("gives the same hash for the same error", () => {
    const first = computeHash(normalize(pythonError(frame)));
    const second = computeHash(normalize(pythonError(frame)));

    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{32}$/);
  });

  it("ignores the line number and the message when there are frames", () => {
    const moved = computeHash(normalize(pythonError({ ...frame, lineno: 99 }, "other text")));

    expect(moved).toBe(computeHash(normalize(pythonError(frame))));
  });

  it("changes when the function changes", () => {
    const other = computeHash(normalize(pythonError({ ...frame, function: "refund" })));

    expect(other).not.toBe(computeHash(normalize(pythonError(frame))));
  });

  it("changes when the source line changes", () => {
    const withLine = (line: string): string =>
      computeHash(normalize(pythonError({ ...frame, context_line: line })));

    expect(withLine("  total = price * qty")).toBe(withLine("total = price * qty  "));
    expect(withLine("total = price * qty")).not.toBe(withLine("total = price + qty"));
  });

  it("uses only in-app frames", () => {
    const base = pythonError(frame);
    const withOtherLibrary = pythonError(frame);

    withOtherLibrary["exception"] = {
      values: [
        {
          type: "ValueError",
          value: "boom",
          stacktrace: {
            frames: [
              { filename: "site-packages/flask/app.py", function: "dispatch", lineno: 5 },
              frame,
            ],
          },
        },
      ],
    };

    expect(computeHash(normalize(withOtherLibrary))).toBe(computeHash(normalize(base)));
  });

  it("groups frameless exceptions by type and parameterized value", () => {
    const hashOf = (value: string): string =>
      computeHash(normalize({ exception: { values: [{ type: "KeyError", value }] } }));

    expect(hashOf("user 123 missing")).toBe(hashOf("user 456 missing"));
    expect(hashOf("user 123 missing")).not.toBe(hashOf("order 123 missing"));
  });

  it("groups messages by their template", () => {
    const hashOf = (formatted: string): string =>
      computeHash(normalize({ logentry: { message: "user %s logged in", formatted } }));

    expect(hashOf("user bob logged in")).toBe(hashOf("user alice logged in"));
  });

  it("parameterizes plain messages", () => {
    const hashOf = (message: string): string => computeHash(normalize({ message }));

    expect(hashOf("retry 3 of 5")).toBe(hashOf("retry 4 of 5"));
    expect(hashOf("retry 3 of 5")).not.toBe(hashOf("giving up"));
  });

  it("honours a client fingerprint", () => {
    const custom = computeHash(normalize({ ...pythonError(frame), fingerprint: ["payments"] }));
    const same = computeHash(normalize({ message: "unrelated", fingerprint: ["payments"] }));

    expect(custom).toBe(same);
    expect(custom).not.toBe(computeHash(normalize(pythonError(frame))));
  });

  it("treats the default fingerprint as no fingerprint", () => {
    const explicit = computeHash(
      normalize({ ...pythonError(frame), fingerprint: ["{{ default }}"] }),
    );

    expect(explicit).toBe(computeHash(normalize(pythonError(frame))));
  });

  it("mixes the default hash into an extended fingerprint", () => {
    const extended = (tenant: string): string =>
      computeHash(normalize({ ...pythonError(frame), fingerprint: ["{{ default }}", tenant] }));

    expect(extended("a")).not.toBe(extended("b"));
    expect(extended("a")).not.toBe(computeHash(normalize(pythonError(frame))));
  });

  it("puts events with nothing to group on into one issue", () => {
    expect(computeHash(normalize({}))).toBe(md5Hex(""));
  });

  it("does not let minified browser frames split an issue across deploys", () => {
    const browserError = (bundle: string, minified: string): string =>
      computeHash(
        normalize({
          platform: "javascript",
          exception: {
            values: [
              {
                type: "TypeError",
                value: "Cannot read properties of undefined (reading 'id')",
                stacktrace: {
                  frames: [
                    {
                      filename: `https://app.example.com/assets/${bundle}.js`,
                      abs_path: `https://app.example.com/assets/${bundle}.js`,
                      function: minified,
                      lineno: 1,
                      colno: 20_331,
                    },
                  ],
                },
              },
            ],
          },
        }),
      );

    expect(browserError("index-a1b2c3", "xe")).toBe(browserError("index-ffee99", "Qt"));
  });
});
