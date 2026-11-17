import { describe, expect, it } from "vitest";

import { computeHash } from "@/core/grouping";
import type { JsonObject } from "@/shared/contract";

import { normalize } from "./helpers";

const frame = (module: string, fn: string): JsonObject => ({
  module,
  function: fn,
  lineno: 1,
});

describe("grouping like Sentry", () => {
  it("ignores generated proxy class names", () => {
    const hash = (suffix: string): string =>
      computeHash(
        normalize({
          platform: "java",
          exception: {
            values: [
              {
                type: "IllegalStateException",
                stacktrace: {
                  frames: [frame(`com.shop.Orders$$EnhancerBySpringCGLIB$$${suffix}`, "place")],
                },
              },
            ],
          },
        }),
      );

    expect(hash("a1b2c3d4")).toBe(hash("0f9e8d7c"));
  });

  it("treats platform frames as library code when the SDK did not say", () => {
    const event = normalize({
      platform: "java",
      exception: {
        values: [
          {
            type: "E",
            stacktrace: {
              frames: [frame("com.shop.Orders", "place"), frame("java.util.HashMap", "get")],
            },
          },
        ],
      },
    });

    expect(event.exceptions[0]?.frames.map((item) => item.inApp)).toEqual([true, false]);
  });

  it("counts each distinct child of an exception group once, in any order", () => {
    const child = (type: string): JsonObject => ({
      type,
      value: "failed",
      stacktrace: { frames: [{ filename: `${type}.cs`, function: "Run", lineno: 1 }] },
    });

    const group = { type: "AggregateException", value: "One or more errors" };

    const hash = (children: string[]): string =>
      computeHash(
        normalize({ platform: "csharp", exception: { values: [...children.map(child), group] } }),
      );

    expect(hash(["A", "B"])).toBe(hash(["B", "A", "A", "B", "A"]));
    expect(hash(["A", "B"])).not.toBe(hash(["A", "C"]));
  });
});
