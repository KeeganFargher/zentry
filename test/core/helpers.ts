import { normalizeEvent } from "@/core/normalize";
import type { EventMeta, Normalized } from "@/core/normalize";
import { WireEvent } from "@/core/wire";
import type { JsonObject, StoredEvent } from "@/shared/contract";

export const RECEIVED_AT = Date.UTC(2026, 10, 17, 10, 30, 0);

export function meta(overrides: Partial<EventMeta> = {}): EventMeta {
  return {
    projectId: 1,
    eventId: "0".repeat(32),
    receivedAt: RECEIVED_AT,
    clientIp: "203.0.113.9",
    userAgent: null,
    sentAt: null,
    ...overrides,
  };
}

/** Validates `raw` as the consumer does, then normalizes it. */
export function normalized(raw: JsonObject, overrides: Partial<EventMeta> = {}): Normalized {
  return normalizeEvent(WireEvent.parse(raw), meta(overrides));
}

export function normalize(raw: JsonObject, overrides: Partial<EventMeta> = {}): StoredEvent {
  return normalized(raw, overrides).event;
}

type FrameInput = { filename: string; function: string; lineno: number; context_line?: string };

/** A Python-style error event with one in-app frame under a library frame. */
export function pythonError(frame: FrameInput, value = "boom"): JsonObject {
  return {
    platform: "python",
    exception: {
      values: [
        {
          type: "ValueError",
          value,
          stacktrace: {
            frames: [
              {
                filename: "site-packages/django/core/handlers.py",
                function: "get_response",
                lineno: 10,
              },
              { ...frame },
            ],
          },
        },
      ],
    },
  };
}
