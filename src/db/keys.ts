// DSN key lookup for the ingest path.

import type { RateLimitReason } from "@/shared/contract";

export type KeyInfo = {
  keyId: number;
  projectId: number;
  /** Null while the project is not limited. */
  rateLimit: { until: number; reason: RateLimitReason } | null;
};

type KeyRow = {
  key_id: number;
  project_id: number;
  rate_limited_until: number | null;
  rate_limit_reason: RateLimitReason | null;
};

export class KeyStore {
  readonly #db: D1Database;

  constructor(db: D1Database) {
    this.#db = db;
  }

  async findActive(publicKey: string): Promise<KeyInfo | null> {
    const row = await this.#db
      .prepare(
        `SELECT k.id AS key_id, k.project_id, p.rate_limited_until, p.rate_limit_reason
         FROM project_keys k JOIN projects p ON p.id = k.project_id
         WHERE k.public_key = ?1 AND k.status = 'active'`,
      )
      .bind(publicKey)
      .first<KeyRow>();

    if (row === null) {
      return null;
    }

    // The table's CHECK keeps the two columns set and cleared together.
    const rateLimit =
      row.rate_limited_until === null || row.rate_limit_reason === null
        ? null
        : { until: row.rate_limited_until, reason: row.rate_limit_reason };

    return { keyId: row.key_id, projectId: row.project_id, rateLimit };
  }
}
