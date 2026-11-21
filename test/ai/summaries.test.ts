import { describe, expect, it } from "vitest";

import { readReply, SUMMARY_MODEL, summaryRequest } from "@/ai/summaries";
import type { SummaryResult } from "@/shared/notify";

/** A reply in the shape Workers AI returned for this model in the spike. */
function reply(content: string): string {
  return JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion",
    model: SUMMARY_MODEL,
    choices: [
      { index: 0, message: { role: "assistant", content }, finish_reason: "stop", logprobs: null },
    ],
    usage: { prompt_tokens: 311, completion_tokens: 40, neurons: 6 },
  });
}

/** The failure's reason; a success fails the test here rather than later. */
function errorOf(result: SummaryResult): string {
  if (result.ok) {
    throw new Error(`expected a refusal, got ${JSON.stringify(result.summary)}`);
  }

  return result.error;
}

describe("Workers AI summary requests", () => {
  it("sends the eval's settings, with no length limits in the JSON schema", () => {
    const request = summaryRequest({ system: "instructions", user: '{"issue":{}}' });

    expect(request).toEqual({
      messages: [
        { role: "system", content: "instructions" },
        { role: "user", content: '{"issue":{}}' },
      ],
      reasoning_effort: "low",
      max_tokens: 2500,
      response_format: {
        type: "json_schema",
        json_schema: {
          type: "object",
          properties: { headline: { type: "string" }, detail: { type: "string" } },
          required: ["headline", "detail"],
          additionalProperties: false,
        },
      },
    });

    expect(SUMMARY_MODEL).toBe("@cf/deepseek-ai/deepseek-v4.1-flash-1017");
  });
});

describe("Workers AI summary replies", () => {
  it("reads the summary from the JSON string in the first choice", () => {
    const answer = JSON.stringify({
      headline: "Discord rate limit blocking price alerts",
      detail: "Discord is rate limiting the webhook, so price alerts are not being sent.",
    });

    expect(readReply(reply(answer))).toEqual({
      ok: true,
      summary: {
        headline: "Discord rate limit blocking price alerts",
        detail: "Discord is rate limiting the webhook, so price alerts are not being sent.",
      },
      model: SUMMARY_MODEL,
    });
  });

  it("trims space around the text", () => {
    const result = readReply(
      reply('{"headline":"  Checkout broke ","detail":" Your checkout handler threw. "}'),
    );

    expect(result).toMatchObject({ ok: true, summary: { headline: "Checkout broke" } });
  });

  it.each([
    ["a headline over 50 characters", `{"headline":"${"x".repeat(51)}","detail":"d"}`],
    ["a detail over 140 characters", `{"headline":"h","detail":"${"x".repeat(141)}"}`],
    ["a line break", '{"headline":"two\\nlines","detail":"d"}'],
    ["an empty headline", '{"headline":"   ","detail":"d"}'],
    ["a key it was not asked for", '{"headline":"h","detail":"d","urgency":"ignore"}'],
    ["a missing key", '{"headline":"h"}'],
    ["JSON cut off by the token limit", '{"headline":"Duplicate key","detail":"'],
  ])("refuses an answer with %s", (_, answer) => {
    expect(errorOf(readReply(reply(answer)))).toMatch(/^answer does not fit: /);
  });

  it.each([
    ["no choices", JSON.stringify({ choices: [] })],
    ["a null answer", JSON.stringify({ choices: [{ message: { content: null } }] })],
    ["the older `response` shape", JSON.stringify({ response: { headline: "h", detail: "d" } })],
  ])("refuses a reply with %s", (_, text) => {
    expect(errorOf(readReply(text))).toMatch(/^unexpected reply: /);
  });
});
