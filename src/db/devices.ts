// Phones signed in to the mobile app, and the pairing codes that sign them
// in. DESIGN.md §19. Codes and tokens arrive here already hashed: the
// plaintext never touches D1.

import { HOUR, MINUTE } from "@/shared/time";

export type DeviceRecord = {
  id: number;
  userId: number;
  name: string;
  pushToken: string | null;
  createdAt: number;
  lastSeenAt: number;
};

export type NewDevice = { userId: number; tokenHash: string; name: string };

/** A device with a push token, as the notify consumer sends to it. */
export type PushTarget = { deviceId: number; userId: number; pushToken: string };

/** How long a pairing code works after the web UI shows it. */
const PAIRING_LIFETIME = 10 * MINUTE;

// `last_seen_at` is for the device list and the idle limit (src/api/router.ts),
// where an hour is precise enough; the coarseness saves a D1 write on almost
// every request.
const TOUCH_EVERY = HOUR;

const DEVICE_COLUMNS = `id, user_id AS userId, name, push_token AS pushToken,
  created_at AS createdAt, last_seen_at AS lastSeenAt`;

export class DeviceStore {
  readonly #db: D1Database;

  constructor(db: D1Database) {
    this.#db = db;
  }

  /** Stores a new code for the user; returns when it stops working. */
  async createPairing(userId: number, codeHash: string, now: number): Promise<number> {
    const expiresAt = now + PAIRING_LIFETIME;

    await this.#db
      .prepare(
        `INSERT INTO device_pairings (code_hash, user_id, expires_at, created_at)
         VALUES (?1, ?2, ?3, ?4)`,
      )
      .bind(codeHash, userId, expiresAt, now)
      .run();

    return expiresAt;
  }

  /**
   * Uses the code up: the user it was made for, or null when it is unknown or
   * expired. Expired codes are deleted on the way, so the table stays small
   * without a cron.
   */
  async redeemPairing(codeHash: string, now: number): Promise<number | null> {
    const db = this.#db;

    const [redeemed] = await db.batch<{ userId: number }>([
      db
        .prepare(
          `DELETE FROM device_pairings WHERE code_hash = ?1 AND expires_at > ?2
           RETURNING user_id AS userId`,
        )
        .bind(codeHash, now),
      db.prepare(`DELETE FROM device_pairings WHERE expires_at <= ?1`).bind(now),
    ]);

    return redeemed?.results[0]?.userId ?? null;
  }

  async create(device: NewDevice, now: number): Promise<DeviceRecord> {
    const row = await this.#db
      .prepare(
        `INSERT INTO devices (user_id, token_hash, name, created_at, last_seen_at)
         VALUES (?1, ?2, ?3, ?4, ?4) RETURNING ${DEVICE_COLUMNS}`,
      )
      .bind(device.userId, device.tokenHash, device.name, now)
      .first<DeviceRecord>();

    if (row === null) {
      throw new Error("device was not created");
    }

    return row;
  }

  async byToken(tokenHash: string): Promise<DeviceRecord | null> {
    return this.#db
      .prepare(`SELECT ${DEVICE_COLUMNS} FROM devices WHERE token_hash = ?1`)
      .bind(tokenHash)
      .first<DeviceRecord>();
  }

  /** Records that the device was used, at most once per TOUCH_EVERY. */
  async touch(device: DeviceRecord, now: number): Promise<void> {
    if (now - device.lastSeenAt < TOUCH_EVERY) {
      return;
    }

    await this.#db
      .prepare(`UPDATE devices SET last_seen_at = ?2 WHERE id = ?1`)
      .bind(device.id, now)
      .run();
  }

  async list(userId: number): Promise<DeviceRecord[]> {
    const { results } = await this.#db
      .prepare(`SELECT ${DEVICE_COLUMNS} FROM devices WHERE user_id = ?1 ORDER BY created_at DESC`)
      .bind(userId)
      .all<DeviceRecord>();

    return results;
  }

  /** Signs the device out. False when the user has no such device. */
  async remove(userId: number, deviceId: number): Promise<boolean> {
    const result = await this.#db
      .prepare(`DELETE FROM devices WHERE id = ?1 AND user_id = ?2`)
      .bind(deviceId, userId)
      .run();

    return result.meta.changes > 0;
  }

  /** Gives the device its push token, taking it from any other row that had it. */
  async setPushToken(deviceId: number, pushToken: string): Promise<void> {
    const db = this.#db;

    await db.batch([
      db
        .prepare(`UPDATE devices SET push_token = NULL WHERE push_token = ?1 AND id <> ?2`)
        .bind(pushToken, deviceId),
      db.prepare(`UPDATE devices SET push_token = ?1 WHERE id = ?2`).bind(pushToken, deviceId),
    ]);
  }

  async clearPushToken(deviceId: number): Promise<void> {
    await this.#db
      .prepare(`UPDATE devices SET push_token = NULL WHERE id = ?1`)
      .bind(deviceId)
      .run();
  }

  /** Expo says the token no longer reaches an install: stop sending to it. */
  async forgetPushToken(pushToken: string): Promise<void> {
    await this.#db
      .prepare(`UPDATE devices SET push_token = NULL WHERE push_token = ?1`)
      .bind(pushToken)
      .run();
  }

  async pushCount(userId: number): Promise<number> {
    const row = await this.#db
      .prepare(`SELECT count(*) AS n FROM devices WHERE user_id = ?1 AND push_token IS NOT NULL`)
      .bind(userId)
      .first<{ n: number }>();

    return row?.n ?? 0;
  }

  /** The users' devices that can receive pushes. */
  async pushTargets(userIds: number[]): Promise<PushTarget[]> {
    if (userIds.length === 0) {
      return [];
    }

    const { results } = await this.#db
      .prepare(
        `SELECT id AS deviceId, user_id AS userId, push_token AS pushToken FROM devices
         WHERE push_token IS NOT NULL AND user_id IN (SELECT value FROM json_each(?1))
         ORDER BY id`,
      )
      .bind(JSON.stringify(userIds))
      .all<PushTarget>();

    return results;
  }
}
