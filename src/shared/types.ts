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

export const INLINE_PAYLOAD_MAX_BYTES = 100_000;
export const MAX_BODY_BYTES = 1_000_000;
export const GROUPING_CONFIG = "lite:2026-11-17";
