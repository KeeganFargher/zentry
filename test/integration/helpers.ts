import { env } from "cloudflare:workers";

import { EventBlobs } from "@/blobs/events";
import { SpillStore } from "@/blobs/spill";
import type { ConsumerDeps } from "@/consumer/handler";
import { BatchStore } from "@/db/batch";
import { ProjectStore } from "@/db/projects";
import type { ProjectRecord } from "@/db/projects";
import type { JsonObject } from "@/shared/contract";
import type { QueueMessage } from "@/shared/types";

export const NOW = Date.UTC(2026, 10, 17, 10, 30, 0);

let sequence = 0;

/** A fresh project per test, so tests do not see each other's rows. */
export async function createProject(
  maxEventsPerHour: number | null = null,
  organizationId = 1,
): Promise<ProjectRecord> {
  sequence += 1;

  const projects = new ProjectStore(env.DB);

  const created = await projects.create({
    organizationId,
    slug: `p${sequence}-${crypto.randomUUID().slice(0, 8)}`,
    name: "Test",
    platform: "python",
    publicKey: crypto.randomUUID().replaceAll("-", ""),
    // High enough that no test trips it by accident; spike tests set their own.
    spikeLimitPerHour: 1_000_000_000,
    now: NOW,
  });

  if (created === null) {
    throw new Error("project slug collision");
  }

  await projects.update(created.id, {
    name: created.name,
    maxEventsPerHour,
    spikeProtection: true,
  });

  return created;
}

let organizations = 0;

/** A fresh organization, for tests that change organization-wide limits. */
export async function createOrganization(maxEventsPerMonth: number): Promise<number> {
  organizations += 1;

  const row = await env.DB.prepare(
    `INSERT INTO organizations (slug, name, max_events_per_month, created_at)
     VALUES (?1, 'Test', ?2, ?3) RETURNING id`,
  )
    .bind(`org${organizations}-${crypto.randomUUID().slice(0, 8)}`, maxEventsPerMonth, NOW)
    .first<{ id: number }>();

  if (row === null) {
    throw new Error("organization was not created");
  }

  return row.id;
}

export function consumerDeps(overrides: Partial<ConsumerDeps> = {}): ConsumerDeps {
  const store = new BatchStore(env.DB);
  const blobs = new EventBlobs(env.BLOBS);
  const spill = new SpillStore(env.BLOBS);

  return {
    readState: (keys) => store.readState(keys),
    readStored: (keys) => store.readStored(keys),
    commit: (writes, now, inputs) => store.commit(writes, now, inputs),
    release: (inputs) => store.release(inputs),
    putBlobs: (events) => blobs.putAll(events),
    loadSpill: (key) => spill.get(key),
    deleteSpill: (keys) => spill.deleteAll(keys),
    notify: async () => {},
    maxStoredPerGroupHour: 100,
    now: () => NOW,
    ...overrides,
  };
}

export function eventId(index: number): string {
  return index.toString(16).padStart(32, "0");
}

type MessageInput = { projectId: number; index: number; event: JsonObject; receivedAt?: number };

export function message(input: MessageInput): QueueMessage {
  return {
    v: 1,
    project_id: input.projectId,
    key_id: 1,
    event_id: eventId(input.index),
    received_at: input.receivedAt ?? NOW,
    client_ip: null,
    user_agent: null,
    sent_at: null,
    payload: JSON.stringify(input.event),
    spill_key: null,
  };
}

export function errorEvent(functionName: string): JsonObject {
  return {
    platform: "python",
    exception: {
      values: [
        {
          type: "ValueError",
          value: "boom",
          stacktrace: { frames: [{ filename: "app/views.py", function: functionName, lineno: 1 }] },
        },
      ],
    },
  };
}

export type GroupRow = {
  id: number;
  short_id: number;
  status: string;
  substatus: string | null;
  times_seen: number;
  title: string;
  last_event_id: string | null;
};

export async function groupsOf(projectId: number): Promise<GroupRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, short_id, status, substatus, times_seen, title, last_event_id
     FROM groups WHERE project_id = ?1 ORDER BY short_id`,
  )
    .bind(projectId)
    .all<GroupRow>();

  return results;
}

export async function count(table: string, projectId: number): Promise<number> {
  const row = await env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE project_id = ?1`)
    .bind(projectId)
    .first<{ n: number }>();

  return row?.n ?? 0;
}
