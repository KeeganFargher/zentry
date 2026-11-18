import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { EventBlobs } from "@/blobs/events";
import { handleBatch, processMessages } from "@/consumer/handler";
import { HOUR, monthBucket } from "@/shared/time";
import type { QueueMessage } from "@/shared/types";

import {
  consumerDeps,
  count,
  createProject,
  errorEvent,
  eventId,
  groupsOf,
  message,
  NOW,
} from "./helpers";

async function limitOf(projectId: number): Promise<{ until: number; reason: string } | null> {
  return env.DB.prepare(
    `SELECT rate_limited_until AS until, rate_limit_reason AS reason
     FROM projects WHERE id = ?1 AND rate_limited_until IS NOT NULL`,
  )
    .bind(projectId)
    .first<{ until: number; reason: string }>();
}

async function monthCount(): Promise<number> {
  const row = await env.DB.prepare(`SELECT received FROM usage_months WHERE month = ?1`)
    .bind(monthBucket(NOW))
    .first<{ received: number }>();

  return row?.received ?? 0;
}

type Settled = { acked: boolean; retried: boolean };

/** A one-message batch that records whether it was acked or sent back. */
function batchOf(body: QueueMessage, settled: Settled): MessageBatch<QueueMessage> {
  const queued: Message<QueueMessage> = {
    id: body.event_id,
    timestamp: new Date(NOW),
    body,
    attempts: 1,
    ack: () => {
      settled.acked = true;
    },
    retry: () => {
      settled.retried = true;
    },
  };

  return {
    messages: [queued],
    queue: "zentry-events",
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    ackAll: () => {
      settled.acked = true;
    },
    retryAll: () => {
      settled.retried = true;
    },
  };
}

describe("consumer", () => {
  it("acks a committed batch even when deleting its spilled payloads fails", async () => {
    const project = await createProject();
    const settled = { acked: false, retried: false };

    const deps = consumerDeps({
      deleteSpill: async () => {
        throw new Error("R2 unavailable");
      },
    });

    const body = message({ projectId: project.id, index: 1, event: errorEvent("checkout") });

    await expect(handleBatch(batchOf(body, settled), deps)).rejects.toThrow(/R2 unavailable/);

    expect(settled).toEqual({ acked: true, retried: false });
    expect((await groupsOf(project.id))[0]).toMatchObject({ times_seen: 1 });
  });

  it("turns 100 copies of one error into one issue seen 100 times", async () => {
    const project = await createProject();

    const messages = Array.from({ length: 100 }, (_, index) =>
      message({ projectId: project.id, index, event: errorEvent("checkout") }),
    );

    await processMessages(messages, consumerDeps());

    const groups = await groupsOf(project.id);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ short_id: 1, times_seen: 100, status: "unresolved" });
    expect(groups[0]?.title).toBe("ValueError: boom");
    expect(await count("events", project.id)).toBe(100);
  });

  it("changes nothing when the same batch is delivered twice", async () => {
    const project = await createProject();

    const messages = [0, 1, 2].map((index) =>
      message({ projectId: project.id, index, event: errorEvent("checkout") }),
    );

    await processMessages(messages, consumerDeps());
    await processMessages(messages, consumerDeps());

    expect((await groupsOf(project.id))[0]?.times_seen).toBe(3);
    expect(await count("events", project.id)).toBe(3);
  });

  it("drops a duplicate event id inside one batch", async () => {
    const project = await createProject();
    const one = message({ projectId: project.id, index: 1, event: errorEvent("checkout") });

    await processMessages([one, one], consumerDeps());

    expect((await groupsOf(project.id))[0]?.times_seen).toBe(1);
  });

  it("gives two new errors in one batch short ids 1 and 2", async () => {
    const project = await createProject();

    await processMessages(
      [
        message({ projectId: project.id, index: 1, event: errorEvent("checkout") }),
        message({ projectId: project.id, index: 2, event: errorEvent("refund") }),
        message({ projectId: project.id, index: 3, event: errorEvent("checkout") }),
      ],
      consumerDeps(),
    );

    const groups = await groupsOf(project.id);

    expect(groups.map((group) => [group.short_id, group.times_seen])).toEqual([
      [1, 2],
      [2, 1],
    ]);

    await processMessages(
      [message({ projectId: project.id, index: 4, event: errorEvent("login") })],
      consumerDeps(),
    );

    expect((await groupsOf(project.id)).map((group) => group.short_id)).toEqual([1, 2, 3]);
  });

  it("stores the event in R2 and records tags and hourly stats", async () => {
    const project = await createProject();
    const event = { ...errorEvent("checkout"), environment: "staging", release: "1.0.0" };

    await processMessages([message({ projectId: project.id, index: 7, event })], consumerDeps());

    const json = await new EventBlobs(env.BLOBS).getJson(project.id, eventId(7));

    const tags = await env.DB.prepare(
      `SELECT key, value, times_seen FROM group_tag_values WHERE project_id = ?1 ORDER BY key`,
    )
      .bind(project.id)
      .all<{ key: string; value: string; times_seen: number }>();

    const stats = await env.DB.prepare(
      `SELECT bucket, count, stored FROM group_stats WHERE project_id = ?1`,
    )
      .bind(project.id)
      .all<{ bucket: number; count: number; stored: number }>();

    expect(json).toContain('"title":"ValueError: boom"');
    expect(tags.results).toContainEqual({ key: "environment", value: "staging", times_seen: 1 });
    expect(tags.results).toContainEqual({ key: "release", value: "1.0.0", times_seen: 1 });
    expect(stats.results).toEqual([{ bucket: NOW - (NOW % HOUR), count: 1, stored: 1 }]);
  });

  it("regresses a resolved issue and leaves an ignored one alone", async () => {
    const project = await createProject();

    const send = async (index: number, name: string, receivedAt: number): Promise<void> =>
      processMessages(
        [message({ projectId: project.id, index, event: errorEvent(name), receivedAt })],
        consumerDeps(),
      );

    await send(1, "checkout", NOW);
    await send(2, "refund", NOW);

    await env.DB.prepare(
      `UPDATE groups SET status = 'resolved', resolved_at = ?2 WHERE project_id = ?1 AND short_id = 1`,
    )
      .bind(project.id, NOW + 1000)
      .run();

    await env.DB.prepare(
      `UPDATE groups SET status = 'ignored' WHERE project_id = ?1 AND short_id = 2`,
    )
      .bind(project.id)
      .run();

    await send(3, "checkout", NOW + 2000);
    await send(4, "refund", NOW + 2000);

    const [first, second] = await groupsOf(project.id);

    expect(first).toMatchObject({ status: "unresolved", substatus: "regressed", times_seen: 2 });
    expect(second).toMatchObject({ status: "ignored", substatus: null, times_seen: 2 });
    expect(await count("activity", project.id)).toBe(1);
  });

  it("does not regress on an event received before the issue was resolved", async () => {
    const project = await createProject();

    await processMessages(
      [message({ projectId: project.id, index: 1, event: errorEvent("checkout") })],
      consumerDeps(),
    );

    await env.DB.prepare(
      `UPDATE groups SET status = 'resolved', resolved_at = ?2 WHERE project_id = ?1`,
    )
      .bind(project.id, NOW + 5000)
      .run();

    await processMessages(
      [
        message({
          projectId: project.id,
          index: 2,
          event: errorEvent("checkout"),
          receivedAt: NOW + 1000,
        }),
      ],
      consumerDeps(),
    );

    expect((await groupsOf(project.id))[0]).toMatchObject({ status: "resolved", times_seen: 2 });
  });

  it("stores only the hourly allowance and counts the rest", async () => {
    const project = await createProject();
    const deps = consumerDeps({ maxStoredPerGroupHour: 5 });

    const batch = (start: number): ReturnType<typeof message>[] =>
      Array.from({ length: 8 }, (_, offset) =>
        message({ projectId: project.id, index: start + offset, event: errorEvent("checkout") }),
      );

    await processMessages(batch(0), deps);

    expect(await count("events", project.id)).toBe(5);

    await processMessages(batch(100), deps);

    expect(await count("events", project.id)).toBe(5);
    expect((await groupsOf(project.id))[0]?.times_seen).toBe(16);

    await processMessages(
      [
        message({
          projectId: project.id,
          index: 999,
          event: errorEvent("checkout"),
          receivedAt: NOW + HOUR,
        }),
      ],
      deps,
    );

    expect(await count("events", project.id)).toBe(6);
  });

  it("leaves no partial writes when the commit fails", async () => {
    const project = await createProject();
    const store = consumerDeps();

    const failing = consumerDeps({
      commit: async (writes, now) => {
        // A second copy of an event row makes the events insert hit its primary key.
        const [first] = writes.events;

        return store.commit({ ...writes, events: first === undefined ? [] : [first, first] }, now);
      },
    });

    const messages = [message({ projectId: project.id, index: 1, event: errorEvent("checkout") })];

    await expect(processMessages(messages, failing)).rejects.toThrow(/UNIQUE constraint/);

    expect(await groupsOf(project.id)).toEqual([]);
    expect(await count("group_stats", project.id)).toBe(0);

    await processMessages(messages, store);

    expect((await groupsOf(project.id))[0]).toMatchObject({ short_id: 1, times_seen: 1 });
  });

  it("sets a rate limit once a project passes its hourly quota", async () => {
    const project = await createProject(3);

    const messages = [1, 2, 3, 4].map((index) =>
      message({ projectId: project.id, index, event: errorEvent("checkout") }),
    );

    await processMessages(messages, consumerDeps());

    const row = await env.DB.prepare(
      `SELECT rate_limited_until AS until FROM projects WHERE id = ?1`,
    )
      .bind(project.id)
      .first<{ until: number | null }>();

    expect(row?.until).toBe(NOW - (NOW % HOUR) + HOUR);
  });

  it("sets a spike-protection limit once a project passes its spike threshold", async () => {
    const project = await createProject(100);

    await env.DB.prepare(`UPDATE projects SET spike_limit_per_hour = 2 WHERE id = ?1`)
      .bind(project.id)
      .run();

    const messages = [1, 2, 3].map((index) =>
      message({ projectId: project.id, index, event: errorEvent("checkout") }),
    );

    await processMessages(messages, consumerDeps());

    expect(await limitOf(project.id)).toEqual({
      until: NOW - (NOW % HOUR) + HOUR,
      reason: "spike_protection",
    });
  });

  it("names the lower limit when a project passes both", async () => {
    const project = await createProject(2);

    await env.DB.prepare(`UPDATE projects SET spike_limit_per_hour = 3 WHERE id = ?1`)
      .bind(project.id)
      .run();

    const messages = [1, 2, 3, 4].map((index) =>
      message({ projectId: project.id, index, event: errorEvent("checkout") }),
    );

    await processMessages(messages, consumerDeps());

    expect((await limitOf(project.id))?.reason).toBe("project_quota");
  });

  it("ignores the spike threshold while spike protection is off", async () => {
    const project = await createProject();

    await env.DB.prepare(
      `UPDATE projects SET spike_limit_per_hour = 1, spike_protection = 0 WHERE id = ?1`,
    )
      .bind(project.id)
      .run();

    const messages = [1, 2, 3].map((index) =>
      message({ projectId: project.id, index, event: errorEvent("checkout") }),
    );

    await processMessages(messages, consumerDeps());

    expect(await limitOf(project.id)).toBeNull();
  });

  it("adds every new event to the month's installation-wide count", async () => {
    const project = await createProject();
    const before = await monthCount();

    const messages = [1, 2, 3].map((index) =>
      message({ projectId: project.id, index, event: errorEvent("checkout") }),
    );

    await processMessages(messages, consumerDeps());
    // A redelivery is a duplicate, and is not counted again.
    await processMessages(messages, consumerDeps());

    expect(await monthCount()).toBe(before + 3);
  });

  it("acks and drops a message that is not JSON", async () => {
    const project = await createProject();

    const bad = {
      ...message({ projectId: project.id, index: 1, event: {} }),
      payload: "{not json",
    };

    await processMessages([bad], consumerDeps());

    expect(await groupsOf(project.id)).toEqual([]);
  });

  it("still stores other projects' events when one project was deleted in flight", async () => {
    const kept = await createProject();
    const deleted = await createProject();

    await env.DB.prepare(`DELETE FROM projects WHERE id = ?1`).bind(deleted.id).run();

    await processMessages(
      [
        message({ projectId: deleted.id, index: 1, event: errorEvent("gone") }),
        message({ projectId: kept.id, index: 2, event: errorEvent("checkout") }),
      ],
      consumerDeps(),
    );

    expect(await groupsOf(kept.id)).toHaveLength(1);
    expect(await groupsOf(deleted.id)).toEqual([]);
    expect(await count("project_stats", deleted.id)).toBe(0);
  });
});
