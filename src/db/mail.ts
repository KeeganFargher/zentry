// What the mailer remembers: each email it has sent, the first email per
// address and issue (for threading), and addresses not to send to.
// DESIGN.md §18.5.

export type SendClaim = "new" | "done";

export type SendRecord = {
  key: string;
  userId: number;
  kind: string;
  groupId: number | null;
};

export type SendOutcome =
  | { status: "sent"; messageId: string }
  | { status: "suppressed" | "failed"; error: string };

export type ThreadStart = { address: string; groupId: number; messageId: string };

export class MailStore {
  readonly #db: D1Database;

  constructor(db: D1Database) {
    this.#db = db;
  }

  /**
   * Records the email as being sent. "done" when an earlier delivery already
   * sent it or gave up on it, so a queue redelivery sends nothing twice. A row
   * left at 'sending' by a crash is sent again: losing the email is worse.
   */
  async claim(record: SendRecord, now: number): Promise<SendClaim> {
    const db = this.#db;

    const [, existing] = await db.batch<{ status: string }>([
      db
        .prepare(
          `INSERT OR IGNORE INTO email_sends (key, user_id, kind, group_id, status, created_at)
           VALUES (?1, ?2, ?3, ?4, 'sending', ?5)`,
        )
        .bind(record.key, record.userId, record.kind, record.groupId, now),
      db.prepare(`SELECT status FROM email_sends WHERE key = ?1`).bind(record.key),
    ]);

    return existing?.results[0]?.status === "sending" ? "new" : "done";
  }

  async settle(key: string, outcome: SendOutcome): Promise<void> {
    const messageId = outcome.status === "sent" ? outcome.messageId : null;
    const error = outcome.status === "sent" ? null : outcome.error;

    await this.#db
      .prepare(`UPDATE email_sends SET status = ?2, message_id = ?3, error = ?4 WHERE key = ?1`)
      .bind(key, outcome.status, messageId, error)
      .run();
  }

  async thread(address: string, groupId: number): Promise<string | null> {
    const row = await this.#db
      .prepare(`SELECT message_id FROM email_threads WHERE address = ?1 AND group_id = ?2`)
      .bind(address, groupId)
      .first<{ message_id: string }>();

    return row?.message_id ?? null;
  }

  /** Keeps the first message: every later one replies to it. */
  async startThread(thread: ThreadStart, now: number): Promise<void> {
    const { address, groupId, messageId } = thread;

    await this.#db
      .prepare(
        `INSERT OR IGNORE INTO email_threads (address, group_id, message_id, created_at)
         SELECT ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM groups WHERE id = ?2)`,
      )
      .bind(address, groupId, messageId, now)
      .run();
  }

  async isSuppressed(address: string, now: number): Promise<boolean> {
    const row = await this.#db
      .prepare(`SELECT 1 AS hit FROM email_suppressions WHERE address = ?1 AND until > ?2`)
      .bind(address, now)
      .first<{ hit: number }>();

    return row !== null;
  }

  async suppress(address: string, until: number, now: number): Promise<void> {
    await this.#db
      .prepare(
        `INSERT INTO email_suppressions (address, reason, until, created_at)
         VALUES (?1, 'suppressed', ?2, ?3)
         ON CONFLICT (address) DO UPDATE SET until = excluded.until`,
      )
      .bind(address, until, now)
      .run();
  }
}
