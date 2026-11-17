// DSN key lookup for the ingest path.

export type KeyInfo = { keyId: number; projectId: number; rateLimitedUntil: number | null };

type KeyRow = { key_id: number; project_id: number; rate_limited_until: number | null };

export class KeyStore {
  readonly #db: D1Database;

  constructor(db: D1Database) {
    this.#db = db;
  }

  async findActive(publicKey: string): Promise<KeyInfo | null> {
    const row = await this.#db
      .prepare(
        `SELECT k.id AS key_id, k.project_id, p.rate_limited_until
         FROM project_keys k JOIN projects p ON p.id = k.project_id
         WHERE k.public_key = ?1 AND k.status = 'active'`,
      )
      .bind(publicKey)
      .first<KeyRow>();

    if (row === null) {
      return null;
    }

    return {
      keyId: row.key_id,
      projectId: row.project_id,
      rateLimitedUntil: row.rate_limited_until,
    };
  }
}
