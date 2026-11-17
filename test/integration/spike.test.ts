import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { runSpikeProtection } from "@/cron/spike";
import { SpikeStore } from "@/db/spike";
import { HOUR, hourBucket } from "@/shared/time";

import { createOrganization, createProject, NOW } from "./helpers";

async function run(): Promise<void> {
  const store = new SpikeStore(env.DB);

  await runSpikeProtection({
    read: (since, before) => store.read(since, before),
    write: (limits) => store.write(limits),
    now: () => NOW,
  });
}

async function spikeLimitOf(projectId: number): Promise<number | null> {
  const row = await env.DB.prepare(
    `SELECT spike_limit_per_hour AS spikeLimit FROM projects WHERE id = ?1`,
  )
    .bind(projectId)
    .first<{ spikeLimit: number | null }>();

  return row?.spikeLimit ?? null;
}

async function recordHours(projectId: number, perHour: number, hours: number): Promise<void> {
  const current = hourBucket(NOW);
  const buckets = Array.from({ length: hours }, (_, index) => current - (index + 1) * HOUR);

  await env.DB.prepare(
    `INSERT INTO project_stats (project_id, bucket, received, stored)
     SELECT ?1, value, ?2, 0 FROM json_each(?3)`,
  )
    .bind(projectId, perHour, JSON.stringify(buckets))
    .run();
}

describe("spike protection cron", () => {
  it("sets three times a steady week's traffic as the threshold", async () => {
    const project = await createProject(null, await createOrganization(1_000));

    await recordHours(project.id, 10_000, 168);
    // The current hour is incomplete and must not count.
    await env.DB.prepare(
      `INSERT INTO project_stats (project_id, bucket, received, stored) VALUES (?1, ?2, 999999, 0)`,
    )
      .bind(project.id, hourBucket(NOW))
      .run();

    await run();

    expect(await spikeLimitOf(project.id)).toBe(30_000);
  });

  it("gives a project with no history the floor", async () => {
    const project = await createProject(null, await createOrganization(1_000));

    await run();

    expect(await spikeLimitOf(project.id)).toBe(500);
  });

  it("leaves a project with spike protection off alone", async () => {
    const project = await createProject(null, await createOrganization(1_000));

    await env.DB.prepare(`UPDATE projects SET spike_protection = 0 WHERE id = ?1`)
      .bind(project.id)
      .run();

    await run();

    // Kept as it was: the consumer ignores it while protection is off.
    expect(await spikeLimitOf(project.id)).toBe(1_000_000_000);
  });
});

describe("rate limit columns", () => {
  it("refuses a limit without a reason, so the UI can always say why", async () => {
    const project = await createProject(null, await createOrganization(1_000));

    await expect(
      env.DB.prepare(`UPDATE projects SET rate_limited_until = 1 WHERE id = ?1`)
        .bind(project.id)
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);
  });
});
