import { describe, expect, it } from "vitest";

import { computeHash } from "@/core/grouping";
import { md5Hex } from "@/core/md5";
import type { JsonObject } from "@/shared/contract";

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

describe("frames the runtime generates", () => {
  const APP = "DataAccess, Version=1.0.0.0, Culture=neutral, PublicKeyToken=null";
  const CORE = "System.Private.CoreLib, Version=9.0.0.0, Culture=neutral";

  const own = (fn: string): JsonObject => ({ function: fn, package: APP, in_app: true });

  /** A Hangfire job's exception, as the .NET SDK sends it: no files, modules cleared. */
  function dotnetError(invoker: JsonObject): JsonObject {
    return {
      platform: "csharp",
      exception: {
        values: [
          {
            type: "System.Exception",
            value: "GeeWiz request failed with HTTP 403",
            stacktrace: {
              frames: [
                {
                  function:
                    "object MethodBaseInvoker.InvokeWithNoArgs(object obj, BindingFlags invokeAttr)",
                  package: CORE,
                  in_app: false,
                },
                invoker,
                own("async Task GeeWizProductFetcher.ProcessAndUploadProductsToQueueAsync()"),
                own("async Task<int> GeeWizProductFetcher.GetTotalPagesToFetchAsync()"),
              ],
            },
          },
        ],
      },
    };
  }

  // Cold, .NET calls the job through the interpreter; warm, through a stub it
  // emits, which has no assembly and which the SDK marks in-app.
  const cold = normalize(
    dotnetError({
      function: "object RuntimeMethodHandle.InvokeMethod(object target, Void** arguments)",
      package: CORE,
      in_app: false,
    }),
  );

  const warm = normalize(
    dotnetError({
      function: "object InvokeStub_TaskAwaiter.GetResult(object, object, IntPtr*)",
      in_app: true,
    }),
  );

  it("does not count a frame without a package as the app's code when the others have one", () => {
    expect(warm.exceptions[0]?.frames[1]?.inApp).toBe(false);
    expect(warm.exceptions[0]?.frames[2]?.inApp).toBe(true);
  });

  it("groups a job's failure the same before and after the runtime warms up", () => {
    expect(computeHash(warm)).toBe(computeHash(cold));
  });

  it("leaves the SDK's flag alone when no frame names a package", () => {
    const event = normalize(pythonError(frame));

    expect(event.exceptions[0]?.frames.map((item) => item.inApp)).toEqual([false, true]);
  });

  it("names the culprit by function when the frame has no module or file", () => {
    expect(warm.culprit).toBe("async Task<int> GeeWizProductFetcher.GetTotalPagesToFetchAsync()");
  });
});
