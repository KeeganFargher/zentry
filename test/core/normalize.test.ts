import { describe, expect, it } from "vitest";

import { prepareEvent } from "@/core/buckets";
import { indexedTags, userLabel } from "@/core/tags";
import type { Json } from "@/shared/contract";

import { normalize, normalized, pythonError, RECEIVED_AT } from "./helpers";

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

  it("drops a field of the wrong type and keeps the rest of the event", () => {
    const event = normalize({
      level: { not: "a level" },
      release: 7,
      exception: { values: [{ type: 42, value: "kept", mechanism: "oops" }, "not an exception"] },
      tags: [["feature", "checkout"], "not a pair", ["count", 3]],
      breadcrumbs: "not a list",
      user: ["not", "an", "object"],
    });

    expect(event.level).toBe("error");
    expect(event.release).toBeNull();
    expect(event.exceptions).toEqual([
      { type: null, value: "kept", module: null, mechanism: null, frames: [] },
    ]);
    expect(event.tags).toEqual([
      ["feature", "checkout"],
      ["count", "3"],
    ]);
    expect(event.breadcrumbs).toEqual([]);
    expect(event.user).toBeNull();
    expect(event.title).toBe("kept");
  });

  // A small payload can nest far deeper than the stack. Depth is capped by
  // trimming, so nothing may walk free-form data before the trimmers do.
  it("survives free-form data nested far deeper than the stack", () => {
    let nested: Json = "bottom";

    for (let level = 0; level < 20_000; level += 1) {
      nested = [nested];
    }

    const body = `${"[".repeat(4000)}${"]".repeat(4000)}`;
    const event = normalize({ extra: { nested }, request: { data: body } });

    expect(event.extra).toEqual({ nested: [[[["[…]"]]]] });
    expect(event.request?.data).toBe(`[[[[["[…]"]]]]]`);
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

    const { event, facts } = normalized({ platform: "javascript" }, { userAgent });
    const tags = new Map(indexedTags(event, facts));

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

  it("scrubs the message template as well as the formatted text", () => {
    const event = normalize({ logentry: { message: "auth Bearer abc123.def456 rejected" } });

    expect(event.message).toEqual({
      message: "auth Bearer [Filtered] rejected",
      formatted: "auth Bearer [Filtered] rejected",
    });
  });

  it("scrubs credentials in the request URL", () => {
    const event = normalize({ request: { url: "https://ada:hunter2@shop.example.com/cart?x=1" } });

    expect(event.request?.url).toBe("https://[Filtered]:[Filtered]@shop.example.com/cart");
  });
});

describe("indexedTags", () => {
  it("lists built-in tags before the event's own and keeps the first value", () => {
    const { event, facts } = normalized({
      ...pythonError(frame),
      release: "1.2.3",
      environment: "staging",
      user: { email: "bob@example.com" },
      tags: { environment: "ignored", feature: "checkout" },
    });

    const tags = new Map(indexedTags(event, facts));

    expect(tags.get("environment")).toBe("staging");
    expect(tags.get("release")).toBe("1.2.3");
    expect(tags.get("user")).toBe("email:bob@example.com");
    expect(tags.get("feature")).toBe("checkout");
    expect(userLabel(facts.user)).toBe("bob@example.com");
  });

  it("scrubs a request body sent as text, whether JSON or form fields", () => {
    const json = normalize({ request: { data: '{"user":"ada","password":"hunter2"}' } });
    const form = normalize({ request: { data: "user=ada&password=hunter2&csrf=abc" } });
    const prose = normalize({ request: { data: "card 4111 1111 1111 1111 on file" } });

    expect(json.request?.data).toBe('{"user":"ada","password":"[Filtered]"}');
    expect(form.request?.data).toBe("user=ada&password=[Filtered]&csrf=[Filtered]");
    expect(prose.request?.data).toBe("card [Filtered] on file");
  });
});

describe("logger", () => {
  it("keeps the logger name and indexes it as a tag", () => {
    const result = normalized({ logger: "Shop.Checkout.PaymentService", message: "declined" });
    const { event, facts } = result;

    expect(event.logger).toBe("Shop.Checkout.PaymentService");
    expect(new Map(indexedTags(event, facts)).get("logger")).toBe("Shop.Checkout.PaymentService");
    expect(prepareEvent(result).metadata.logger).toBe("Shop.Checkout.PaymentService");
  });
});

describe("titles", () => {
  it("says a value that is mostly not text is binary data", () => {
    const gzip = "\u001f�\b\u0000\u0000\tn�\u0000�\u0004��\t\u0000!\f\u0003�]";
    const event = normalize({ exception: [{ type: "System.Exception", value: gzip }] });

    expect(event.title).toBe("System.Exception: <binary data>");
  });

  it("keeps a readable value readable, marking each run of unprintable characters once", () => {
    const event = normalize({
      exception: [{ type: "Error", value: "bad\u0000\u0001 input\tfrom user" }],
    });

    expect(event.title).toBe("Error: bad� input from user");
  });

  it("keeps the value as it was sent in the stored event", () => {
    const event = normalize({ exception: [{ type: "Error", value: "a\u0000b" }] });

    expect(event.exceptions[0]?.value).toBe("a\u0000b");
  });
});

describe("titles of structured values", () => {
  it("uses the whole value on one line when its first line has no words, as a JSON body", () => {
    const body =
      '{\n   "errors" : [ {\n      "code" : "500",\n      "message" : "SQL search error"\n   } ]\n}';

    const event = normalize({ exception: [{ type: "System.Exception", value: body }] });

    expect(event.title).toBe(
      'System.Exception: { "errors" : [ { "code" : "500", "message" : "SQL search error" } ] }',
    );
  });

  it("still uses the first line when it says something", () => {
    const event = normalize({ exception: [{ type: "Error", value: "bad total\n{ details }" }] });

    expect(event.title).toBe("Error: bad total");
  });
});
