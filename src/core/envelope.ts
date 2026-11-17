// Sentry envelope parsing. Rules follow relay-server/src/envelope/mod.rs:
// work on bytes, `length` is optional, the final newline is optional. Each
// header line is validated by its schema as it is read; a header that is not
// a JSON object makes the envelope malformed.

import { z } from "zod";

import { normalizeEventId } from "@/shared/ids";
import { jsonText } from "@/shared/json";
import { Label, lenient } from "@/shared/schema";

/** The public key is the DSN's username. */
function dsnPublicKey(dsn: string): string | null {
  const url = URL.parse(dsn);

  return url === null || url.username === "" ? null : url.username;
}

const EnvelopeHeader = jsonText(
  z
    .object({
      event_id: lenient(Label.transform(normalizeEventId)),
      sent_at: lenient(Label),
      dsn: lenient(Label.transform(dsnPublicKey)),
    })
    .transform((header) => ({
      eventId: header.event_id,
      sentAt: header.sent_at,
      publicKey: header.dsn,
    })),
);

const ItemHeader = jsonText(
  z.object({
    type: lenient(Label),
    length: lenient(z.number()),
  }),
);

export type EnvelopeHeader = z.output<typeof EnvelopeHeader>;

export type ItemHeader = z.output<typeof ItemHeader>;

export type EnvelopeItem = { header: ItemHeader; payload: Uint8Array };

export type Envelope = { header: EnvelopeHeader; items: EnvelopeItem[] };

const NEWLINE = 0x0a;
const decoder = new TextDecoder();

type Cursor = { bytes: Uint8Array; position: number };

function readLine(cursor: Cursor): Uint8Array {
  const found = cursor.bytes.indexOf(NEWLINE, cursor.position);
  const end = found === -1 ? cursor.bytes.length : found;
  const line = cursor.bytes.subarray(cursor.position, end);

  cursor.position = end + 1;

  return line;
}

function readHeader<T extends z.ZodType>(cursor: Cursor, schema: T): z.output<T> | null {
  const parsed = schema.safeParse(decoder.decode(readLine(cursor)));

  return parsed.success ? parsed.data : null;
}

function readPayload(cursor: Cursor, length: number | null): Uint8Array | null {
  if (length === null) {
    return readLine(cursor);
  }

  const end = cursor.position + length;

  if (length < 0 || end > cursor.bytes.length) {
    return null;
  }

  const payload = cursor.bytes.subarray(cursor.position, end);

  cursor.position = cursor.bytes[end] === NEWLINE ? end + 1 : end;

  return payload;
}

function atBlankTail(cursor: Cursor): boolean {
  const rest = cursor.bytes.subarray(cursor.position);

  return rest.every((byte) => byte === NEWLINE || byte === 0x0d || byte === 0x20);
}

/** Returns null when the envelope is malformed. */
export function parseEnvelope(bytes: Uint8Array): Envelope | null {
  const cursor: Cursor = { bytes, position: 0 };
  const header = readHeader(cursor, EnvelopeHeader);

  if (header === null) {
    return null;
  }

  const items: EnvelopeItem[] = [];

  while (cursor.position < bytes.length && !atBlankTail(cursor)) {
    const itemHeader = readHeader(cursor, ItemHeader);
    const payload = itemHeader === null ? null : readPayload(cursor, itemHeader.length);

    if (itemHeader === null || payload === null) {
      return null;
    }

    items.push({ header: itemHeader, payload });
  }

  return { header, items };
}

/** The first `event` item. Every other item type is dropped. */
export function findEventItem(envelope: Envelope): EnvelopeItem | null {
  return envelope.items.find((candidate) => candidate.header.type === "event") ?? null;
}

/** The payload of the first `event` item, as text. */
export function findEventPayload(envelope: Envelope): string | null {
  const item = findEventItem(envelope);

  return item === null ? null : decoder.decode(item.payload);
}
