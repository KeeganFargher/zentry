// Notification settings and issue subscriptions. DESIGN.md §18.2.

import type {
  NotificationProvider,
  NotificationScope,
  NotificationType,
  NotificationValue,
} from "@/shared/contract";
import type { Recipient } from "@/shared/notify";

/** One stored choice; the same shape as core's SettingRow. */
export type StoredSetting = {
  provider: NotificationProvider;
  userId: number;
  type: NotificationType;
  scope: NotificationScope;
  scopeId: number;
  value: NotificationValue;
};

export type SettingKey = Omit<StoredSetting, "value">;

export type Subscriber = { userId: number; active: boolean };

const SETTING_COLUMNS = `provider, user_id AS userId, type, scope, scope_id AS scopeId, value`;

export class NotificationSettingsStore {
  readonly #db: D1Database;

  constructor(db: D1Database) {
    this.#db = db;
  }

  /** The user's rows, for every provider, that can apply inside one organization. */
  async forUser(userId: number, organizationId: number): Promise<StoredSetting[]> {
    const { results } = await this.#db
      .prepare(
        `SELECT ${SETTING_COLUMNS} FROM notification_settings
         WHERE user_id = ?1 AND (
           (scope = 'user' AND scope_id = ?1)
           OR (scope = 'organization' AND scope_id = ?2)
           OR (scope = 'project' AND scope_id IN (SELECT id FROM projects WHERE organization_id = ?2)))
         ORDER BY provider, type, scope, scope_id`,
      )
      .bind(userId, organizationId)
      .all<StoredSetting>();

    return results;
  }

  async set(setting: StoredSetting, now: number): Promise<void> {
    await this.#db
      .prepare(
        `INSERT INTO notification_settings (user_id, provider, type, scope, scope_id, value, updated_at)
         VALUES (?1, ?7, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (user_id, provider, type, scope, scope_id)
         DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .bind(
        setting.userId,
        setting.type,
        setting.scope,
        setting.scopeId,
        setting.value,
        now,
        setting.provider,
      )
      .run();
  }

  async clear(key: SettingKey): Promise<void> {
    await this.#db
      .prepare(
        `DELETE FROM notification_settings
         WHERE user_id = ?1 AND provider = ?5 AND type = ?2 AND scope = ?3 AND scope_id = ?4`,
      )
      .bind(key.userId, key.type, key.scope, key.scopeId, key.provider)
      .run();
  }

  /** Every member of the organization, with an address to send to. */
  async members(organizationId: number): Promise<Recipient[]> {
    const { results } = await this.#db
      .prepare(
        `SELECT u.id AS userId, u.email FROM organization_members m
         JOIN users u ON u.id = m.user_id
         WHERE m.organization_id = ?1 ORDER BY u.id`,
      )
      .bind(organizationId)
      .all<Recipient>();

    return results;
  }

  /** The organization's members' rows for one type and provider. */
  async ofMembers(
    organizationId: number,
    type: NotificationType,
    provider: NotificationProvider,
  ): Promise<StoredSetting[]> {
    const { results } = await this.#db
      .prepare(
        `SELECT ${SETTING_COLUMNS} FROM notification_settings
         WHERE provider = ?3 AND type = ?2
           AND user_id IN (SELECT user_id FROM organization_members WHERE organization_id = ?1)`,
      )
      .bind(organizationId, type, provider)
      .all<StoredSetting>();

    return results;
  }

  async subscribers(groupId: number): Promise<Subscriber[]> {
    const { results } = await this.#db
      .prepare(`SELECT user_id AS userId, active FROM issue_subscriptions WHERE group_id = ?1`)
      .bind(groupId)
      .all<{ userId: number; active: number }>();

    return results.map((row) => ({ userId: row.userId, active: row.active === 1 }));
  }

  /** True when the user follows the issue. */
  async isSubscribed(userId: number, groupId: number): Promise<boolean> {
    const row = await this.#db
      .prepare(`SELECT active FROM issue_subscriptions WHERE user_id = ?1 AND group_id = ?2`)
      .bind(userId, groupId)
      .first<{ active: number }>();

    return row?.active === 1;
  }

  /** An explicit follow or unfollow, which replaces whatever was there. */
  async setSubscription(subscriber: Subscriber, groupId: number, now: number): Promise<void> {
    await this.#db
      .prepare(
        `INSERT INTO issue_subscriptions (user_id, group_id, active, reason, created_at)
         VALUES (?1, ?2, ?3, 'manual', ?4)
         ON CONFLICT (user_id, group_id)
         DO UPDATE SET active = excluded.active, reason = 'manual'`,
      )
      .bind(subscriber.userId, groupId, subscriber.active ? 1 : 0, now)
      .run();
  }
}
