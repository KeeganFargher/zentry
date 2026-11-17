// Sentry envelope parsing. Rules follow relay-server/src/envelope/mod.rs:
// work on bytes, `length` is optional, the final newline is optional.

import type { JsonObject } from "@/shared/contract";
import { asObject, getNonEmpty, getNumber, parseJson } from "@/shared/json";

export type EnvelopeItem = { header: JsonObject; payload: Uint8Array };

export type Envelope = { header: JsonObject; items: EnvelopeItem[] };

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

function readHeader(cursor: Cursor): JsonObject | null {
  return asObject(parseJson(decoder.decode(readLine(cursor))));
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
  const header = readHeader(cursor);

  if (header === null) {
    return null;
  }

  const items: EnvelopeItem[] = [];

  while (cursor.position < bytes.length && !atBlankTail(cursor)) {
    const itemHeader = readHeader(cursor);

    const payload =
      itemHeader === null ? null : readPayload(cursor, getNumber(itemHeader, "length"));

    if (itemHeader === null || payload === null) {
      return null;
    }

    items.push({ header: itemHeader, payload });
  }

  return { header, items };
}

/** The first `event` item. Every other item type is dropped. */
export function findEventItem(envelope: Envelope): EnvelopeItem | null {
  return (
    envelope.items.find((candidate) => getNonEmpty(candidate.header, "type") === "event") ?? null
  );
}

/** The payload of the first `event` item, as text. */
export function findEventPayload(envelope: Envelope): string | null {
  const item = findEventItem(envelope);

  return item === null ? null : decoder.decode(item.payload);
}

/** The public key from the envelope header's `dsn`, if there is one. */
export function envelopePublicKey(envelope: Envelope): string | null {
  const dsn = getNonEmpty(envelope.header, "dsn");
  const url = dsn === null ? null : URL.parse(dsn);

  return url === null || url.username === "" ? null : url.username;
}
