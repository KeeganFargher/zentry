// The Expo push service: every request to exp.host. DESIGN.md §19.
// https://docs.expo.dev/push-notifications/sending-notifications/
//
// Expo forwards to FCM (and APNs), so the Worker needs no Google credentials;
// those are uploaded to the Expo project once. Replies are parsed here, at the
// edge, and handed on as plain results.

import { z } from "zod";

import { jsonText } from "@/shared/json";
import { errorText } from "@/shared/log";
import { RECEIPT_BATCH, SEND_BATCH } from "@/shared/push";
import type { PushMessage, PushReceipt, PushResult, PushTicket } from "@/shared/push";

const SEND_URL = "https://exp.host/--/api/v2/push/send";
const RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";

const Ticket = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), id: z.string() }),
  z.object({
    status: z.literal("error"),
    message: z.string(),
    details: z.object({ error: z.string().optional() }).optional(),
  }),
]);

const Receipt = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok") }),
  z.object({
    status: z.literal("error"),
    message: z.string(),
    details: z.object({ error: z.string().optional() }).optional(),
  }),
]);

const SendReply = jsonText(z.object({ data: z.array(Ticket) }));
const ReceiptsReply = jsonText(z.object({ data: z.record(z.string(), Receipt) }));

type Fetcher = typeof fetch;

/** POSTs JSON to Expo; the reply text, or why there is none. */
async function post(fetcher: Fetcher, url: string, body: string): Promise<PushResult<string>> {
  let response: Response;

  try {
    response = await fetcher(url, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body,
    });
  } catch (cause) {
    return { ok: false, retryable: true, error: `network: ${errorText(cause)}` };
  }

  const text = await response.text();

  if (!response.ok) {
    const retryable = response.status === 429 || response.status >= 500;

    return { ok: false, retryable, error: `HTTP ${response.status}: ${text.slice(0, 500)}` };
  }

  return { ok: true, value: text };
}

export class ExpoPush {
  readonly #fetch: Fetcher;

  constructor(fetcher: Fetcher) {
    this.#fetch = fetcher;
  }

  /** At most SEND_BATCH messages. Tickets come back in the messages' order. */
  async send(messages: PushMessage[]): Promise<PushResult<PushTicket[]>> {
    if (messages.length > SEND_BATCH) {
      throw new Error(`at most ${SEND_BATCH} pushes per request, got ${messages.length}`);
    }

    const reply = await post(this.#fetch, SEND_URL, JSON.stringify(messages));

    if (!reply.ok) {
      return reply;
    }

    const parsed = SendReply.safeParse(reply.value);

    if (!parsed.success || parsed.data.data.length !== messages.length) {
      // Expo answered 200 with something else. Sending again could notify
      // twice, so this is not retried; it is logged by the caller.
      return {
        ok: false,
        retryable: false,
        error: `unexpected reply: ${reply.value.slice(0, 500)}`,
      };
    }

    return {
      ok: true,
      value: parsed.data.data.map((ticket): PushTicket =>
        ticket.status === "ok"
          ? ticket
          : { status: "error", message: ticket.message, error: ticket.details?.error ?? null },
      ),
    };
  }

  /** Receipts by ticket id. Ids Expo has no receipt for yet are absent. */
  async receipts(ids: string[]): Promise<PushResult<Map<string, PushReceipt>>> {
    if (ids.length > RECEIPT_BATCH) {
      throw new Error(`at most ${RECEIPT_BATCH} receipts per request, got ${ids.length}`);
    }

    const reply = await post(this.#fetch, RECEIPTS_URL, JSON.stringify({ ids }));

    if (!reply.ok) {
      return reply;
    }

    const parsed = ReceiptsReply.safeParse(reply.value);

    if (!parsed.success) {
      return {
        ok: false,
        retryable: false,
        error: `unexpected reply: ${reply.value.slice(0, 500)}`,
      };
    }

    const receipts = new Map<string, PushReceipt>();

    for (const [id, receipt] of Object.entries(parsed.data.data)) {
      receipts.set(
        id,
        receipt.status === "ok"
          ? receipt
          : { status: "error", message: receipt.message, error: receipt.details?.error ?? null },
      );
    }

    return { ok: true, value: receipts };
  }
}
