import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { EventBlobs } from "@/blobs/events";
import { processMessages } from "@/consumer/handler";
import { HOUR } from "@/shared/time";

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

describe("consumer", () => {
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

        await store.commit({ ...writes, events: first === undefined ? [] : [first, first] }, now);
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
