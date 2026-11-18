// What the push sender remembers: each push it has sent to each device, so a
// queue redelivery never pushes twice, and the Expo ticket whose receipt the
// hourly cron reads. DESIGN.md §19.

export type PushClaim = "new" | "done";

/** Where one push goes: the device, and the token it had when the push was sent. */
export type PushAddress = { deviceId: number; pushToken: string };

export type PushOutcome =
  | { status: "sent"; ticketId: string }
  | { status: "delivered" }
  | { status: "failed"; error: string };

/** A push Expo accepted whose receipt has not been read yet. */
export type AwaitingReceipt = {
  key: string;
  ticketId: string;
  pushToken: string;
  createdAt: number;
};

export type ReceiptWindow = { since: number; before: number };

/** Where a page of receipts starts: after this push. */
export type ReceiptCursor = { createdAt: number; key: string };

export class PushSendStore {
  readonly #db: D1Database;

  constructor(db: D1Database) {
    this.#db = db;
  }

  /**
   * Records the push as being sent. "done" when an earlier delivery already
   * sent it or gave up; a row left at 'sending' by a crash is sent again, as
   * for email: a lost alert is worse than a duplicate.
   */
  async claim(key: string, address: PushAddress, now: number): Promise<PushClaim> {
    const db = this.#db;

    const [, existing] = await db.batch<{ status: string }>([
      db
        .prepare(
          `INSERT OR IGNORE INTO push_sends (key, device_id, push_token, status, created_at)
           VALUES (?1, ?2, ?3, 'sending', ?4)`,
        )
        .bind(key, address.deviceId, address.pushToken, now),
      db.prepare(`SELECT status FROM push_sends WHERE key = ?1`).bind(key),
    ]);

    return existing?.results[0]?.status === "sending" ? "new" : "done";
  }

  async settle(key: string, outcome: PushOutcome): Promise<void> {
    const ticketId = outcome.status === "sent" ? outcome.ticketId : null;
    const error = outcome.status === "failed" ? outcome.error : null;

    await this.#db
      .prepare(
        `UPDATE push_sends SET status = ?2, ticket_id = coalesce(?3, ticket_id), error = ?4
         WHERE key = ?1`,
      )
      .bind(key, outcome.status, ticketId, error)
      .run();
  }

  /**
   * Pushes sent in the window whose receipt is still unread, oldest first,
   * after `cursor` (the last one of the previous page), so a page Expo had no
   * receipts for yet does not hide the pages after it.
   */
  async awaitingReceipts(
    window: ReceiptWindow,
    cursor: ReceiptCursor,
    limit: number,
  ): Promise<AwaitingReceipt[]> {
    const { results } = await this.#db
      .prepare(
        `SELECT key, ticket_id AS ticketId, push_token AS pushToken, created_at AS createdAt
         FROM push_sends
         WHERE status = 'sent' AND created_at >= ?1 AND created_at < ?2
           AND (created_at, key) > (?3, ?4)
         ORDER BY created_at, key LIMIT ?5`,
      )
      .bind(window.since, window.before, cursor.createdAt, cursor.key, limit)
      .all<AwaitingReceipt>();

    return results;
  }

  /**
   * Expo keeps receipts for a day. A push still waiting after that will never
   * learn its fate, so it is settled as failed, saying so, rather than left
   * looking in flight until retention deletes it.
   */
  async expireReceipts(before: number): Promise<number> {
    const result = await this.#db
      .prepare(
        `UPDATE push_sends SET status = 'failed', error = 'no receipt within a day'
         WHERE status = 'sent' AND created_at < ?1`,
      )
      .bind(before)
      .run();

    return result.meta.changes;
  }
}
