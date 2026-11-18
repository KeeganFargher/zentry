// Users, organizations and membership.

export type UserRecord = { id: number; email: string };

export type Membership = {
  id: number;
  slug: string;
  name: string;
  role: "owner" | "member";
};

const DEFAULT_ORGANIZATION_ID = 1;

export class TenancyStore {
  readonly #db: D1Database;

  constructor(db: D1Database) {
    this.#db = db;
  }

  /**
   * Records the user on first sight and adds them to the default
   * organization. The first member ever becomes its owner.
   */
  async ensureUser(email: string, now: number): Promise<UserRecord | null> {
    const db = this.#db;
    const address = email.toLowerCase();

    await db.batch([
      db
        .prepare(
          `INSERT INTO users (email, created_at, last_seen_at) VALUES (?1, ?2, ?2)
           ON CONFLICT(email) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
        )
        .bind(address, now),
      db
        .prepare(
          `INSERT OR IGNORE INTO organization_members (organization_id, user_id, role, created_at)
           SELECT ?3, u.id,
                  CASE WHEN EXISTS (SELECT 1 FROM organization_members WHERE organization_id = ?3)
                       THEN 'member' ELSE 'owner' END,
                  ?2
           FROM users u WHERE u.email = ?1 AND u.created_at = ?2`,
        )
        .bind(address, now, DEFAULT_ORGANIZATION_ID),
    ]);

    return db
      .prepare(`SELECT id, email FROM users WHERE email = ?1`)
      .bind(address)
      .first<UserRecord>();
  }

  /** The user a device token belongs to. Never creates one: a device is only ever made for a user. */
  async user(userId: number): Promise<UserRecord | null> {
    return this.#db
      .prepare(`SELECT id, email FROM users WHERE id = ?1`)
      .bind(userId)
      .first<UserRecord>();
  }

  async memberships(userId: number): Promise<Membership[]> {
    const { results } = await this.#db
      .prepare(
        `SELECT o.id, o.slug, o.name, m.role
         FROM organization_members m JOIN organizations o ON o.id = m.organization_id
         WHERE m.user_id = ?1 ORDER BY o.slug`,
      )
      .bind(userId)
      .all<Membership>();

    return results;
  }
}
