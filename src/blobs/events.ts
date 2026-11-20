// Full event JSON in R2. This file owns the `events/` key layout.

import { z } from "zod";

import { jsonText } from "@/shared/json";
import type { EventSummary } from "@/shared/notify";
import { Flag, Text, lenient, lenientList } from "@/shared/schema";

export type EventBlob = { projectId: number; eventId: string; json: string };

const MaybeText = lenient(z.string());

const SummaryFrame = z.object({
  module: MaybeText,
  filename: MaybeText,
  function: MaybeText,
  lineno: lenient(z.number()),
  colno: lenient(z.number()),
  inApp: Flag,
  contextLine: MaybeText,
});

const SummaryException = z.object({
  type: MaybeText,
  value: MaybeText,
  frames: lenientList(SummaryFrame),
});

const SummaryUser = z
  .object({ id: lenient(Text), email: MaybeText, username: MaybeText, ip_address: MaybeText })
  .transform(({ ip_address: ipAddress, ...rest }) => ({ ...rest, ipAddress }));

// Ingest stored it without its query string and scrubbed of credentials
// (core/context.ts), so it can go to Workers AI as it is.
const SummaryUrl = z.object({ url: MaybeText }).transform(({ url }) => url);

const SummaryRuntime = z
  .object({ runtime: lenient(z.object({ name: MaybeText })) })
  .transform(({ runtime }) => runtime?.name ?? null);

const SummaryMessage = z
  .object({ message: MaybeText, formatted: MaybeText })
  .transform((message) => message.formatted ?? message.message);

/**
 * The parts of a stored event an alert email shows. Read leniently: an event
 * stored by an older version keeps its alert, with whatever fields it has.
 */
const StoredSummary: z.ZodType<EventSummary, string> = jsonText(
  z
    .object({
      eventId: z.string(),
      timestamp: z.number(),
      environment: z.string().catch(""),
      release: MaybeText,
      platform: MaybeText,
      transaction: MaybeText,
      request: lenient(SummaryUrl),
      contexts: lenient(SummaryRuntime),
      message: lenient(SummaryMessage).transform((message) => message ?? null),
      exceptions: lenientList(SummaryException),
      tags: lenientList(z.tuple([z.string(), z.string()])),
      user: lenient(SummaryUser),
    })
    .transform(({ request, contexts, ...rest }) => ({ ...rest, url: request, runtime: contexts })),
);

const PUT_CONCURRENCY = 10;
const DELETE_CHUNK = 1000;

function eventKey(projectId: number, eventId: string): string {
  return `events/${projectId}/${eventId}.json.gz`;
}

async function gzip(text: string): Promise<ArrayBuffer> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));

  return new Response(stream).arrayBuffer();
}

async function gunzip(body: ReadableStream): Promise<string> {
  return new Response(body.pipeThrough(new DecompressionStream("gzip"))).text();
}

export class EventBlobs {
  readonly #bucket: R2Bucket;

  constructor(bucket: R2Bucket) {
    this.#bucket = bucket;
  }

  async #put(blob: EventBlob): Promise<void> {
    await this.#bucket.put(eventKey(blob.projectId, blob.eventId), await gzip(blob.json), {
      httpMetadata: { contentType: "application/json", contentEncoding: "gzip" },
    });
  }

  /** Writes every blob, a few at a time. Rejects if any write fails. */
  async putAll(blobs: EventBlob[]): Promise<void> {
    for (let start = 0; start < blobs.length; start += PUT_CONCURRENCY) {
      const chunk = blobs.slice(start, start + PUT_CONCURRENCY);

      await Promise.all(chunk.map((blob) => this.#put(blob)));
    }
  }

  /** The stored event as JSON text, or null when it is gone. */
  async getJson(projectId: number, eventId: string): Promise<string | null> {
    const object = await this.#bucket.get(eventKey(projectId, eventId));

    return object === null ? null : gunzip(object.body);
  }

  /** What an alert shows of the event; null when it is gone or unreadable. */
  async summary(projectId: number, eventId: string): Promise<EventSummary | null> {
    const json = await this.getJson(projectId, eventId);
    const parsed = json === null ? null : StoredSummary.safeParse(json);

    return parsed?.success === true ? parsed.data : null;
  }

  async deleteAll(projectId: number, eventIds: string[]): Promise<void> {
    for (let start = 0; start < eventIds.length; start += DELETE_CHUNK) {
      const keys = eventIds.slice(start, start + DELETE_CHUNK).map((id) => eventKey(projectId, id));

      await this.#bucket.delete(keys);
    }
  }
}
