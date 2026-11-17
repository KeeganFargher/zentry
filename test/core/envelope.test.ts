import { describe, expect, it } from "vitest";

import { findEventPayload, parseEnvelope } from "@/core/envelope";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("parseEnvelope", () => {
  it("reads an event item with an explicit length", () => {
    const payload = '{"message":"hello"}';

    const envelope = parseEnvelope(
      encode(`{"event_id":"abc"}\n{"type":"event","length":${payload.length}}\n${payload}\n`),
    );

    expect(envelope?.items).toHaveLength(1);
    expect(envelope === null ? null : findEventPayload(envelope)).toBe(payload);
  });

  it("reads an item without a length up to the newline", () => {
    const envelope = parseEnvelope(encode('{}\n{"type":"event"}\n{"message":"x"}'));

    expect(envelope === null ? null : findEventPayload(envelope)).toBe('{"message":"x"}');
  });

  it("counts length in bytes, not characters", () => {
    const payload = '{"message":"héllo ✓"}';
    const bytes = encode(payload).length;
    const envelope = parseEnvelope(encode(`{}\n{"type":"event","length":${bytes}}\n${payload}\n`));

    expect(envelope === null ? null : findEventPayload(envelope)).toBe(payload);
  });

  it("allows a payload that contains newlines when length is given", () => {
    const payload = "line one\nline two";

    const envelope = parseEnvelope(
      encode(
        `{}\n{"type":"attachment","length":${payload.length}}\n${payload}\n{"type":"event"}\n{"a":1}\n`,
      ),
    );

    expect(envelope?.items).toHaveLength(2);
    expect(envelope === null ? null : findEventPayload(envelope)).toBe('{"a":1}');
  });

  it("skips non-event items", () => {
    const envelope = parseEnvelope(
      encode('{}\n{"type":"session"}\n{"sid":"1"}\n{"type":"client_report"}\n{}\n'),
    );

    expect(envelope?.items).toHaveLength(2);
    expect(envelope === null ? "x" : findEventPayload(envelope)).toBeNull();
  });

  it("accepts an envelope with only a header", () => {
    expect(parseEnvelope(encode("{}\n"))?.items).toEqual([]);
    expect(parseEnvelope(encode("{}"))?.items).toEqual([]);
  });

  it("rejects a header that is not JSON", () => {
    expect(parseEnvelope(encode("not json\n"))).toBeNull();
    expect(parseEnvelope(encode('{}\nnot json\n{"a":1}\n'))).toBeNull();
  });

  it("rejects a length that runs past the end", () => {
    expect(parseEnvelope(encode('{}\n{"type":"event","length":500}\n{}'))).toBeNull();
  });

  it("reads the public key from the dsn header", () => {
    const envelope = parseEnvelope(encode('{"dsn":"https://abc123@ingest.example.com/7"}\n'));

    expect(envelope?.header.publicKey).toBe("abc123");
  });
});
