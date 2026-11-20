// Workers AI: the plain-language summary in an issue's push. DESIGN.md §19.2.
// The model, its settings and the prompt came out of a model eval
// (docs/push-summaries-eval.md); rerun it before changing them.
//
// Replies are parsed here, at the edge, and handed on as a SummaryResult. A
// failure is returned rather than thrown: the caller sends the push in its
// plain form, and a lost alert would be worse than an ugly one.

import { z } from "zod";

import { jsonText } from "@/shared/json";
import { errorText } from "@/shared/log";
import type { SummaryPrompt, SummaryResult } from "@/shared/notify";

/**
 * DeepSeek v4.1 Flash with low reasoning scored best in the eval, ahead of
 * dearer models. Workers AI retires models often; a retired one fails every
 * call (`5028 … was deprecated`), which shows in the logs as push summaries
 * failing.
 */
export const SUMMARY_MODEL = "@cf/deepseek-ai/deepseek-v4.1-flash-1017";

// Reasoning spends most of these; at 1,200 one eval answer was cut off mid-JSON.
const MAX_TOKENS = 2500;

// The prompt asks for 45 and 120 characters. These are the hard limits: what
// fits a lock screen line and Android's collapsed body.
const MAX_HEADLINE = 50;
const MAX_DETAIL = 140;

/**
 * Sent as `response_format`. No `maxLength`: the model's constrained decoding
 * enforces it by cutting the text off mid-sentence, so the limits are asked
 * for in the prompt and checked below instead.
 */
const ANSWER_SCHEMA = {
  type: "object",
  properties: { headline: { type: "string" }, detail: { type: "string" } },
  required: ["headline", "detail"],
  additionalProperties: false,
};

const OneLine = (max: number): z.ZodString =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[^\r\n]*$/u);

const Answer = jsonText(
  z.strictObject({ headline: OneLine(MAX_HEADLINE), detail: OneLine(MAX_DETAIL) }),
);

// OpenAI's chat completion shape, which this model answers in; the answer is a
// JSON string in the first choice.
const Reply = jsonText(
  z.object({
    choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1),
  }),
);

/** Reads a Workers AI reply as JSON text. Exported for tests, which feed recorded replies. */
export function readReply(text: string): SummaryResult {
  const reply = Reply.safeParse(text);
  const content = reply.success ? reply.data.choices[0]?.message.content : undefined;

  if (content === undefined) {
    return { ok: false, error: `unexpected reply: ${text.slice(0, 300)}` };
  }

  const answer = Answer.safeParse(content);

  if (!answer.success) {
    return { ok: false, error: `answer does not fit: ${content.slice(0, 300)}` };
  }

  return { ok: true, summary: answer.data, model: SUMMARY_MODEL };
}

export type SummaryRequest = {
  messages: { role: "system" | "user"; content: string }[];
  reasoning_effort: "low";
  max_tokens: number;
  response_format: { type: "json_schema"; json_schema: typeof ANSWER_SCHEMA };
};

/** What is sent for one prompt. Exported for tests, which pin the eval's settings. */
export function summaryRequest(prompt: SummaryPrompt): SummaryRequest {
  return {
    messages: [
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user },
    ],
    reasoning_effort: "low",
    max_tokens: MAX_TOKENS,
    response_format: { type: "json_schema", json_schema: ANSWER_SCHEMA },
  };
}

export class IssueSummarizer {
  readonly #ai: Ai;

  constructor(ai: Ai) {
    this.#ai = ai;
  }

  async summarize(prompt: SummaryPrompt): Promise<SummaryResult> {
    // The binding has no types for this model and returns a plain record.
    // Reading it back as text keeps `unknown` out of this module and goes
    // through the same parser the tests drive. Undefined when it answered
    // nothing at all.
    let reply: string | undefined;

    try {
      reply = JSON.stringify(await this.#ai.run(SUMMARY_MODEL, summaryRequest(prompt)));
    } catch (cause) {
      // An outage, the 20-a-minute limit (3021), a retired model (5028), or
      // no credentials under tests: all mean "no summary this time".
      return { ok: false, error: `Workers AI: ${errorText(cause)}` };
    }

    return reply === undefined
      ? { ok: false, error: "Workers AI answered nothing" }
      : readReply(reply);
  }
}
