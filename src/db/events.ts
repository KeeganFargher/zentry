// Event index queries for the read API. "Newest first" means
// ts DESC, event_id ASC, which is the order of the events_by_group index.

import type { ApiEventRow } from "@/shared/contract";

export type EventCursor = { timestamp: number; eventId: string };

export type EventRef = { projectId: number; eventId: string; timestamp: number };

/** The issue an event is looked up under. */
export type IssueRef = { id: number; projectId: number };

export type Neighbours = { previous: string | null; next: string | null };

type IdRow = { eventId: string };

const SELECT_REF = `SELECT project_id AS projectId, event_id AS eventId, ts AS timestamp FROM events`;

const OLDER = `(ts < ?2 OR (ts = ?2 AND event_id > ?3))`;
const NEWER = `(ts > ?2 OR (ts = ?2 AND event_id < ?3))`;

export class EventStore {
  readonly #db: D1Database;

  constructor(db: D1Database) {
    this.#db = db;
  }

  async list(issueId: number, cursor: EventCursor | null, limit: number): Promise<ApiEventRow[]> {
    const after = cursor ?? { timestamp: Number.MAX_SAFE_INTEGER, eventId: "" };

    const { results } = await this.#db
      .prepare(
        `SELECT event_id AS eventId, ts AS timestamp, level, release, environment,
                user_label AS user, title
         FROM events WHERE group_id = ?1 AND ${OLDER}
         ORDER BY ts DESC, event_id ASC LIMIT ?4`,
      )
      .bind(issueId, after.timestamp, after.eventId, limit)
      .all<ApiEventRow>();

    return results;
  }

  async latest(issueId: number): Promise<EventRef | null> {
    return this.#db
      .prepare(`${SELECT_REF} WHERE group_id = ?1 ORDER BY ts DESC, event_id ASC LIMIT 1`)
      .bind(issueId)
      .first<EventRef>();
  }

  async oldest(issueId: number): Promise<EventRef | null> {
    return this.#db
      .prepare(`${SELECT_REF} WHERE group_id = ?1 ORDER BY ts ASC, event_id DESC LIMIT 1`)
      .bind(issueId)
      .first<EventRef>();
  }

  /** Looked up by the primary key (project, event id), then checked against the issue. */
  async find(issue: IssueRef, eventId: string): Promise<EventRef | null> {
    return this.#db
      .prepare(`${SELECT_REF} WHERE project_id = ?1 AND event_id = ?2 AND group_id = ?3`)
      .bind(issue.projectId, eventId, issue.id)
      .first<EventRef>();
  }

  /** The events just older (previous) and just newer (next) than `ref`. */
  async neighbours(issueId: number, ref: EventRef): Promise<Neighbours> {
    const db = this.#db;

    const [previous, next] = await Promise.all([
      db
        .prepare(
          `SELECT event_id AS eventId FROM events WHERE group_id = ?1 AND ${OLDER}
           ORDER BY ts DESC, event_id ASC LIMIT 1`,
        )
        .bind(issueId, ref.timestamp, ref.eventId)
        .first<IdRow>(),
      db
        .prepare(
          `SELECT event_id AS eventId FROM events WHERE group_id = ?1 AND ${NEWER}
           ORDER BY ts ASC, event_id DESC LIMIT 1`,
        )
        .bind(issueId, ref.timestamp, ref.eventId)
        .first<IdRow>(),
    ]);

    return { previous: previous?.eventId ?? null, next: next?.eventId ?? null };
  }

  /** Every stored event id of an issue, for deleting its R2 objects. */
  async idsOf(issueId: number): Promise<string[]> {
    const { results } = await this.#db
      .prepare(`SELECT event_id AS eventId FROM events WHERE group_id = ?1`)
      .bind(issueId)
      .all<IdRow>();

    return results.map((row) => row.eventId);
  }
}
