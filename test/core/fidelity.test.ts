import { describe, expect, it } from "vitest";

import { computeHash } from "@/core/grouping";
import { scrubText } from "@/core/scrub";

import { normalize, pythonError } from "./helpers";

const frames = [
  { filename: "app/jobs.py", function: "run", lineno: 7 },
  { filename: "app/db.py", function: "query", lineno: 3 },
];

describe("stacks outside `exception`", () => {
  it("uses the crashed thread when there is no exception", () => {
    const event = normalize({
      platform: "csharp",
      message: "Unhandled",
      threads: {
        values: [
          { id: 1, stacktrace: { frames: [{ function: "Idle" }] } },
          { id: 2, crashed: true, stacktrace: { frames } },
        ],
      },
    });

    expect(event.exceptions).toHaveLength(1);
    expect(event.exceptions[0]?.frames.map((frame) => frame.function)).toEqual(["run", "query"]);
    expect(event.title).toBe("Unhandled");
    expect(event.culprit).toBe("app/db.py in query");
  });

  it("uses a top-level stacktrace, and puts it on an exception that has none", () => {
    const event = normalize({
      exception: { values: [{ type: "Boom", value: "x" }] },
      stacktrace: { frames },
    });

    expect(event.exceptions[0]?.type).toBe("Boom");
    expect(event.exceptions[0]?.frames).toHaveLength(2);
  });

  it("groups two events with the same thread stack together, whatever the message", () => {
    const thread = { values: [{ crashed: true, stacktrace: { frames } }] };
    const first = normalize({ message: "one", threads: thread });
    const second = normalize({ message: "two", threads: thread });

    expect(computeHash(first)).toBe(computeHash(second));
  });
});

describe("scrubbing", () => {
  it("filters hyphenated key names", () => {
    const event = normalize({
      request: { headers: { "X-Api-Key": "k1", "api-key": "k2", Accept: "*/*" } },
    });

    expect(event.request?.headers).toEqual([
      ["X-Api-Key", "[Filtered]"],
      ["api-key", "[Filtered]"],
      ["Accept", "*/*"],
    ]);
  });

  it("finds secrets inside text", () => {
    expect(scrubText("connect postgres://admin:hunter2@db.internal:5432/app failed")).toBe(
      "connect postgres://[Filtered]:[Filtered]@db.internal:5432/app failed",
    );

    expect(scrubText("Authorization: Bearer eyJhbGciOi.payload.sig")).toBe(
      "Authorization: Bearer [Filtered]",
    );

    expect(scrubText("pay GB82 WEST 1234 5698 7654 32 now")).toBe("pay [Filtered] now");
    expect(scrubText("key -----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY----- end")).toBe(
      "key [Filtered] end",
    );
  });

  it("leaves ordinary text alone", () => {
    expect(scrubText("Bearer authentication failed for GB12 and AB12 3456")).toBe(
      "Bearer authentication failed for GB12 and AB12 3456",
    );

    expect(scrubText("http://example.com/path and user@host")).toBe(
      "http://example.com/path and user@host",
    );
  });
});

describe("user IP", () => {
  const origin = { userAgent: "Mozilla/5.0", clientIp: "203.0.113.9" };

  it("is inferred for a browser SDK unless it said never to", () => {
    expect(normalize({ platform: "javascript", user: { id: "1" } }, origin).user).toEqual({
      id: "1",
      ip_address: "203.0.113.9",
    });

    const never = normalize(
      {
        platform: "javascript",
        user: { id: "1", ip_address: "{{auto}}" },
        sdk: { settings: { infer_ip: "never" } },
      },
      origin,
    );

    expect(never.user).toEqual({ id: "1" });
  });

  it("keeps an address the SDK sent on purpose", () => {
    const sent = { user: { ip_address: "198.51.100.4" }, sdk: { settings: { infer_ip: "never" } } };

    expect(normalize(sent, origin).user).toEqual({ ip_address: "198.51.100.4" });
  });
});

describe("fingerprints", () => {
  const base = pythonError(frames[0] ?? { filename: "", function: "", lineno: 0 });

  it("treats {{default}} without spaces as the default", () => {
    const plain = normalize(base);

    expect(computeHash(normalize({ ...base, fingerprint: ["{{default}}"] }))).toBe(
      computeHash(plain),
    );

    expect(computeHash(normalize({ ...base, fingerprint: ["{{ default }}", "tenant-a"] }))).toBe(
      computeHash(normalize({ ...base, fingerprint: ["{{default}}", "tenant-a"] })),
    );
  });

  it("expands variables, so two transactions make two issues", () => {
    const hash = (transaction: string, tag: string): string =>
      computeHash(
        normalize({
          ...base,
          transaction,
          tags: { region: tag },
          fingerprint: ["{{ transaction }}", "{{ tags.region }}", "{{ type }}"],
        }),
      );

    expect(hash("GET /a", "eu")).not.toBe(hash("GET /b", "eu"));
    expect(hash("GET /a", "eu")).not.toBe(hash("GET /a", "us"));
    expect(hash("GET /a", "eu")).toBe(hash("GET /a", "eu"));
  });
});

describe("small fields", () => {
  it("maps level aliases and numbers", () => {
    const level = (value: string | number): string => normalize({ level: value }).level;

    expect(level("log")).toBe("info");
    expect(level("WARN")).toBe("warning");
    expect(level("critical")).toBe("fatal");
    expect(level(40)).toBe("error");
    expect(level(30)).toBe("warning");
    expect(level(10)).toBe("debug");
    expect(level("nonsense")).toBe("error");
  });

  it("keeps the context nearest the error", () => {
    const lines = Array.from({ length: 15 }, (_, index) => `line ${index}`);

    const event = normalize({
      exception: {
        values: [
          {
            type: "E",
            stacktrace: {
              frames: [{ function: "f", pre_context: lines, post_context: lines }],
            },
          },
        ],
      },
    });

    const [frame] = event.exceptions[0]?.frames ?? [];

    expect(frame?.preContext[0]).toBe("line 5");
    expect(frame?.postContext[0]).toBe("line 0");
    expect(frame?.postContext).toHaveLength(10);
  });

  it("fills a log message from its params but groups by the template", () => {
    const one = normalize({ logentry: { message: "user %s failed %d times", params: ["ana", 3] } });
    const two = normalize({ logentry: { message: "user %s failed %d times", params: ["bo", 9] } });
    const named = normalize({ logentry: { message: "hi {name}, {0}", params: { name: "x" } } });

    expect(one.title).toBe("user ana failed 3 times");
    expect(one.message?.message).toBe("user %s failed %d times");
    expect(computeHash(one)).toBe(computeHash(two));
    expect(named.message?.formatted).toBe("hi x, {0}");
  });
});
