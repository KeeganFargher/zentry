import { describe, expect, it } from "vitest";

import { ExpoPush } from "@/push/expo";
import type { PushMessage } from "@/shared/push";

const MESSAGE: PushMessage = {
  to: "ExponentPushToken[a]",
  title: "New issue",
  body: "TypeError",
  data: { kind: "issue", organization: "default", issueId: 1 },
  channelId: "alerts",
};

type FakeExpo = { client: ExpoPush; bodies: string[] };

/** An Expo that answers every request with `status` and `body`. */
function expoAnswering(status: number, body: string): FakeExpo {
  const bodies: string[] = [];

  const client = new ExpoPush(async (input, init) => {
    bodies.push(await new Request(input, init).text());

    return new Response(body, { status });
  });

  return { client, bodies };
}

describe("Expo push client", () => {
  it("sends the messages as a JSON array and reads the tickets in order", async () => {
    const { client, bodies } = expoAnswering(
      200,
      JSON.stringify({
        data: [
          { status: "ok", id: "receipt-1" },
          {
            status: "error",
            message: "not registered",
            details: { error: "DeviceNotRegistered" },
          },
        ],
      }),
    );

    const result = await client.send([MESSAGE, { ...MESSAGE, to: "ExponentPushToken[b]" }]);

    expect(bodies[0]).toBe(JSON.stringify([MESSAGE, { ...MESSAGE, to: "ExponentPushToken[b]" }]));
    expect(result).toEqual({
      ok: true,
      value: [
        { status: "ok", id: "receipt-1" },
        { status: "error", message: "not registered", error: "DeviceNotRegistered" },
      ],
    });
  });

  it("says to retry on 429 and 5xx, and not on 400", async () => {
    expect(await expoAnswering(429, "slow down").client.send([MESSAGE])).toMatchObject({
      ok: false,
      retryable: true,
    });
    expect(await expoAnswering(503, "down").client.send([MESSAGE])).toMatchObject({
      ok: false,
      retryable: true,
    });
    expect(await expoAnswering(400, "bad").client.send([MESSAGE])).toMatchObject({
      ok: false,
      retryable: false,
    });
  });

  it("says to retry when Expo cannot be reached", async () => {
    const client = new ExpoPush(async () => {
      throw new TypeError("network down");
    });

    expect(await client.send([MESSAGE])).toMatchObject({ ok: false, retryable: true });
  });

  it("does not retry a 200 it cannot read, which might have been sent", async () => {
    const { client } = expoAnswering(200, JSON.stringify({ data: [] }));

    expect(await client.send([MESSAGE])).toMatchObject({ ok: false, retryable: false });
  });

  it("refuses more than Expo takes in one request", async () => {
    const { client } = expoAnswering(200, "{}");

    await expect(client.send(Array.from({ length: 101 }, () => MESSAGE))).rejects.toThrow(/100/);
  });

  it("reads receipts by ticket id", async () => {
    const { client } = expoAnswering(
      200,
      JSON.stringify({
        data: {
          a: { status: "ok" },
          b: { status: "error", message: "bad key", details: { error: "InvalidCredentials" } },
        },
      }),
    );

    const result = await client.receipts(["a", "b", "c"]);

    expect(result.ok && [...result.value.entries()]).toEqual([
      ["a", { status: "ok" }],
      ["b", { status: "error", message: "bad key", error: "InvalidCredentials" }],
    ]);
  });
});
