// Auth tokens for sentry-cli (DESIGN.md §20). Tokens arrive here already
// hashed: the plaintext never touches D1.

import { HOUR } from "@/shared/time";

import type { Membership, UserRecord } from "./tenancy";

export type CliTokenRecord = {
  id: number;
  name: string;
  hint: string;
  createdAt: number;
  lastUsedAt: number | null;
};

export type NewCliToken = {
  userId: number;
  organizationId: number;
  name: string;
  tokenHash: string;
  hint: string;
};

/** Who a token acts for: its member, and the one organization it reaches. */
export type CliCaller = {
  tokenId: number;
  lastUsedAt: number | null;
  user: UserRecord;
  organization: Membership & { createdAt: number };
};

type CallerRow = {
  tokenId: number;
  lastUsedAt: number | null;
  userId: number;
  email: string;
  organizationId: number;
  slug: string;
  name: string;
  role: Membership["role"];
  createdAt: number;
};

// Shown in the token list, where an hour is precise enough; the coarseness
// saves a D1 write on almost every CLI request.
const TOUCH_EVERY = HOUR;

const TOKEN_COLUMNS = `id, name, token_hint AS hint, created_at AS createdAt, last_used_at AS lastUsedAt`;

export class CliTokenStore {
  readonly #db: D1Database;

  constructor(db: D1Database) {
    this.#db = db;
  }

  async create(token: NewCliToken, now: number): Promise<CliTokenRecord> {
    const row = await this.#db
      .prepare(
        `INSERT INTO cli_tokens (user_id, organization_id, name, token_hash, token_hint, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6) RETURNING ${TOKEN_COLUMNS}`,
      )
      .bind(token.userId, token.organizationId, token.name, token.tokenHash, token.hint, now)
      .first<CliTokenRecord>();

    if (row === null) {
      throw new Error("cli token was not created");
    }

    return row;
  }

  /**
   * The token's member and organization, or null when the token is unknown or
   * its member has left the organization. Read on every request, never
   * cached, so revoking a token or removing a member takes effect at once.
   */
  async caller(tokenHash: string): Promise<CliCaller | null> {
    const row = await this.#db
      .prepare(
        `SELECT t.id AS tokenId, t.last_used_at AS lastUsedAt, u.id AS userId, u.email,
                o.id AS organizationId, o.slug, o.name, m.role, o.created_at AS createdAt
         FROM cli_tokens t
         JOIN users u ON u.id = t.user_id
         JOIN organization_members m ON m.user_id = t.user_id AND m.organization_id = t.organization_id
         JOIN organizations o ON o.id = t.organization_id
         WHERE t.token_hash = ?1`,
      )
      .bind(tokenHash)
      .first<CallerRow>();

    if (row === null) {
      return null;
    }

    return {
      tokenId: row.tokenId,
      lastUsedAt: row.lastUsedAt,
      user: { id: row.userId, email: row.email },
      organization: {
        id: row.organizationId,
        slug: row.slug,
        name: row.name,
        role: row.role,
        createdAt: row.createdAt,
      },
    };
  }

  /** Records that the token was used, at most once per TOUCH_EVERY. */
  async touch(caller: CliCaller, now: number): Promise<void> {
    if (caller.lastUsedAt !== null && now - caller.lastUsedAt < TOUCH_EVERY) {
      return;
    }

    await this.#db
      .prepare(`UPDATE cli_tokens SET last_used_at = ?2 WHERE id = ?1`)
      .bind(caller.tokenId, now)
      .run();
  }

  /** The member's own tokens for one organization, newest first. */
  async list(userId: number, organizationId: number): Promise<CliTokenRecord[]> {
    const { results } = await this.#db
      .prepare(
        `SELECT ${TOKEN_COLUMNS} FROM cli_tokens WHERE user_id = ?1 AND organization_id = ?2
         ORDER BY created_at DESC, id DESC`,
      )
      .bind(userId, organizationId)
      .all<CliTokenRecord>();

    return results;
  }

  /** False when the member has no such token in this organization. */
  async revoke(userId: number, organizationId: number, tokenId: number): Promise<boolean> {
    const result = await this.#db
      .prepare(`DELETE FROM cli_tokens WHERE id = ?1 AND user_id = ?2 AND organization_id = ?3`)
      .bind(tokenId, userId, organizationId)
      .run();

    return result.meta.changes > 0;
  }
}
