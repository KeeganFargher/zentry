import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { processMessages } from "@/consumer/handler";
import { runRetention } from "@/cron/retention";
import type { RetentionDeps } from "@/cron/retention";
import { RetentionStore } from "@/db/retention";
import { DAY, HOUR } from "@/shared/time";

import { consumerDeps, count, createProject, errorEvent, groupsOf, message, NOW } from "./helpers";

function retentionDeps(now: number): RetentionDeps {
  const store = new RetentionStore(env.DB);

  return {
    deleteEventsBefore: (cutoff) => store.deleteEventsBefore(cutoff),
    deleteStatsBefore: (cutoffs) => store.deleteStatsBefore(cutoffs),
    pruneTags: (keep) => store.pruneTags(keep),
    clearExpiredLimits: (time) => store.clearExpiredLimits(time),
    retentionDays: 90,
    now: () => now,
  };
}

describe("retention", () => {
  it("removes old events and keeps every issue, so a recurrence is a regression", async () => {
    const project = await createProject();
    const old = NOW - 100 * DAY;

    const send = async (index: number, name: string, at: number): Promise<void> =>
      processMessages(
        [
          message({
            projectId: project.id,
            index,
            receivedAt: at,
            event: { ...errorEvent(name), timestamp: at / 1000 },
          }),
        ],
        consumerDeps({ now: () => at }),
      );

    await send(1, "stale", old);
    await send(2, "active", old);
    await send(3, "active", NOW);

    await runRetention(retentionDeps(NOW + HOUR));

    const groups = await groupsOf(project.id);

    expect(groups.map((group) => group.times_seen).toSorted((a, b) => a - b)).toEqual([1, 2]);

    expect(await count("events", project.id)).toBe(1);
    expect(await count("grouphashes", project.id)).toBe(2);
  });

  it("keeps only the most-seen values of a high-cardinality tag", async () => {
    const project = await createProject();

    await processMessages(
      [message({ projectId: project.id, index: 1, event: errorEvent("checkout") })],
      consumerDeps(),
    );

    const [group] = await groupsOf(project.id);

    const values = Array.from({ length: 250 }, (_, index) => ({
      v: `user-${index}`,
      n: index + 1,
    }));

    await env.DB.prepare(
      `INSERT INTO group_tag_values (group_id, key, value, project_id, times_seen, first_seen, last_seen)
       SELECT ?1, 'user', value->>'v', ?2, value->>'n', 0, 0 FROM json_each(?3)`,
    )
      .bind(group?.id ?? 0, project.id, JSON.stringify(values))
      .run();

    await runRetention(retentionDeps(NOW));

    const kept = await env.DB.prepare(
      `SELECT count(*) AS n, min(times_seen) AS least FROM group_tag_values
       WHERE group_id = ?1 AND key = 'user'`,
    )
      .bind(group?.id ?? 0)
      .first<{ n: number; least: number }>();

    expect(kept).toEqual({ n: 200, least: 51 });
  });

  it("clears a rate limit that has expired", async () => {
    const project = await createProject();

    await env.DB.prepare(`UPDATE projects SET rate_limited_until = ?2 WHERE id = ?1`)
      .bind(project.id, NOW - 1)
      .run();

    await runRetention(retentionDeps(NOW));

    const row = await env.DB.prepare(
      `SELECT rate_limited_until AS until FROM projects WHERE id = ?1`,
    )
      .bind(project.id)
      .first<{ until: number | null }>();

    expect(row?.until).toBeNull();
  });
});
