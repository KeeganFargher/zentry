import { describe, expect, it } from "vitest";

import { indexedTags, userLabel } from "@/core/tags";

import { normalize, pythonError, RECEIVED_AT } from "./helpers";

const frame = { filename: "app/views.py", function: "checkout", lineno: 42 };

describe("normalizeEvent", () => {
  it("derives title, culprit and defaults", () => {
    const event = normalize(pythonError(frame, "bad total\nsecond line"));

    expect(event.title).toBe("ValueError: bad total");
    expect(event.culprit).toBe("app/views.py in checkout");
    expect(event.level).toBe("error");
    expect(event.environment).toBe("production");
    expect(event.timestamp).toBe(RECEIVED_AT);
  });

  it("marks library frames as not in-app unless the SDK said otherwise", () => {
    const [library, app] = normalize(pythonError(frame)).exceptions[0]?.frames ?? [];

    expect(library?.inApp).toBe(false);
    expect(app?.inApp).toBe(true);
  });

  it("accepts a bare exception list and a plain message", () => {
    const event = normalize({ exception: [{ type: "Oops", value: "x" }], message: "hello" });

    expect(event.exceptions).toHaveLength(1);
    expect(event.message?.formatted).toBe("hello");
  });

  it("titles a message event by its first line", () => {
    expect(normalize({ message: "disk full\ndetails" }).title).toBe("disk full");
    expect(normalize({}).title).toBe("<unlabeled event>");
  });

  it("reads epoch seconds and ISO timestamps", () => {
    const seconds = (RECEIVED_AT - 5000) / 1000;

    expect(normalize({ timestamp: seconds }).timestamp).toBe(RECEIVED_AT - 5000);

    expect(normalize({ timestamp: new Date(RECEIVED_AT - 5000).toISOString() }).timestamp).toBe(
      RECEIVED_AT - 5000,
    );
  });

  it("clamps timestamps that are in the future or very old", () => {
    expect(normalize({ timestamp: RECEIVED_AT / 1000 + 3600 }).timestamp).toBe(RECEIVED_AT);
    expect(normalize({ timestamp: 1_000_000 }).timestamp).toBe(RECEIVED_AT);
  });

  it("corrects for a client clock that is far off", () => {
    const clientNow = RECEIVED_AT - 2 * 3600 * 1000;

    const event = normalize(
      { timestamp: (clientNow - 1000) / 1000 },
      { sentAt: new Date(clientNow).toISOString() },
    );

    expect(event.timestamp).toBe(RECEIVED_AT - 1000);
  });

  it("keeps at most 250 frames, from both ends", () => {
    const frames = Array.from({ length: 400 }, (_, index) => ({ function: `f${index}` }));
    const event = normalize({ exception: { values: [{ type: "E", stacktrace: { frames } }] } });
    const kept = event.exceptions[0]?.frames ?? [];

    expect(kept).toHaveLength(250);
    expect(kept[0]?.function).toBe("f0");
    expect(kept.at(-1)?.function).toBe("f399");
  });

  it("fills the client IP for browser events and for {{auto}}", () => {
    expect(normalize({ platform: "javascript" }).user).toEqual({ ip_address: "203.0.113.9" });

    expect(
      normalize({ platform: "python", user: { id: "7", ip_address: "{{auto}}" } }).user,
    ).toEqual({
      id: "7",
      ip_address: "203.0.113.9",
    });

    expect(normalize({ platform: "python" }).user).toBeNull();
  });

  it("moves the query string out of the request URL", () => {
    const event = normalize({
      request: { url: "https://x.test/pay?token=abc&page=2", method: "GET" },
    });

    expect(event.request?.url).toBe("https://x.test/pay");
    expect(event.request?.queryString).toBe("token=[Filtered]&page=2");
  });

  it("fills browser and OS contexts from the User-Agent", () => {
    const userAgent =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

    const event = normalize({ platform: "javascript" }, { userAgent });
    const tags = new Map(indexedTags(event));

    expect(tags.get("browser")).toBe("Chrome 131");
    expect(tags.get("browser.name")).toBe("Chrome");
    expect(tags.get("os.name")).toBe("macOS");
  });
});

describe("scrubbing", () => {
  it("filters sensitive keys everywhere free-form data is kept", () => {
    const event = normalize({
      extra: { password: "hunter2", nested: { api_key: "k", fine: "ok" } },
      user: { id: "1", session_token: "s" },
      request: {
        headers: { Authorization: "Bearer x", Accept: "*/*" },
        data: { secret: "s", n: 1 },
      },
      tags: { auth_mode: "sso", region: "eu" },
      contexts: { app: { csrf: "t" } },
    });

    expect(event.extra).toEqual({
      password: "[Filtered]",
      nested: { api_key: "[Filtered]", fine: "ok" },
    });
    expect(event.user).toEqual({ id: "1", session_token: "[Filtered]" });

    expect(event.request?.headers).toEqual([
      ["Authorization", "[Filtered]"],
      ["Accept", "*/*"],
    ]);

    expect(event.request?.data).toEqual({ secret: "[Filtered]", n: 1 });

    expect(event.tags).toEqual([
      ["auth_mode", "[Filtered]"],
      ["region", "eu"],
    ]);

    expect(event.contexts).toEqual({ app: { csrf: "[Filtered]" } });
  });

  it("filters card numbers but not other long numbers", () => {
    const event = normalize({
      message: "charge failed for 4242 4242 4242 4242 at 1731840000000",
      extra: { card: "4111111111111111", order: "1234567890123456" },
    });

    expect(event.message?.formatted).toBe("charge failed for [Filtered] at 1731840000000");
    expect(event.extra).toEqual({ card: "[Filtered]", order: "1234567890123456" });
  });

  it("filters local variables and breadcrumb data", () => {
    const event = normalize({
      breadcrumbs: { values: [{ message: "login", data: { password: "x", user: "bob" } }] },
      exception: {
        values: [
          {
            type: "E",
            stacktrace: { frames: [{ function: "f", vars: { token: "t", count: 3 } }] },
          },
        ],
      },
    });

    expect(event.breadcrumbs[0]?.data).toEqual({ password: "[Filtered]", user: "bob" });
    expect(event.exceptions[0]?.frames[0]?.vars).toEqual({ token: "[Filtered]", count: 3 });
  });
});

describe("indexedTags", () => {
  it("lists built-in tags before the event's own and keeps the first value", () => {
    const event = normalize({
      ...pythonError(frame),
      release: "1.2.3",
      environment: "staging",
      user: { email: "bob@example.com" },
      tags: { environment: "ignored", feature: "checkout" },
    });

    const tags = new Map(indexedTags(event));

    expect(tags.get("environment")).toBe("staging");
    expect(tags.get("release")).toBe("1.2.3");
    expect(tags.get("user")).toBe("email:bob@example.com");
    expect(tags.get("feature")).toBe("checkout");
    expect(userLabel(event.user)).toBe("bob@example.com");
  });
});
