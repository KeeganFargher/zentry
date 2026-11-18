// Types used across the Worker that are not part of the UI contract.

/** One accepted event on its way from ingest to the consumer. */
export type QueueMessage = {
  v: 1;
  project_id: number;
  key_id: number;
  event_id: string;
  /** Milliseconds since the epoch. */
  received_at: number;
  client_ip: string | null;
  user_agent: string | null;
  /** The envelope header's `sent_at`, for clock-drift correction. */
  sent_at: string | null;
  /** Event JSON, when it is at most INLINE_PAYLOAD_MAX_BYTES. */
  payload: string | null;
  /** R2 key of the event JSON, when it is larger. */
  spill_key: string | null;
};

/**
 * Work for the notify consumer. `drain` reads the outbox (DESIGN.md §18);
 * `digest` flushes one project's digest window once it is due.
 */
export type NotifyMessage = { kind: "drain" } | { kind: "digest"; project_id: number };

export const INLINE_PAYLOAD_MAX_BYTES = 100_000;

/** One event, as Relay's `max_event_size`. */
export const MAX_EVENT_BYTES = 1_000_000;

/** A whole envelope, so an event can travel with attachments. Only the event is kept. */
export const MAX_ENVELOPE_BYTES = 10_000_000;
export const GROUPING_CONFIG = "lite:2026-11-18";
