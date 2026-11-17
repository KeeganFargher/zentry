import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { handleApi, Sessions } from "@/api/router";
import { EventBlobs } from "@/blobs/events";
import { processMessages } from "@/consumer/handler";
import { spikeFloor } from "@/core/spike";
import type {
  ApiActivity,
  ApiEventDetail,
  ApiEventList,
  ApiIssue,
  ApiIssueList,
  ApiIssueStats,
  ApiKey,
  ApiMe,
  ApiOrganizationLimits,
  ApiProject,
  ApiTag,
} from "@/shared/contract";

import { api, apiDeps, claims, signToken, USER } from "./api-helpers";
import { consumerDeps, errorEvent, eventId, message, NOW } from "./helpers";

async function newProject(name: string): Promise<ApiProject> {
  const response = await api("/organizations/default/projects/", {
    method: "POST",
    body: { name },
  });

  return response.json<ApiProject>();
}

type Sent = { index: number; name: string; at?: number; environment?: string };

async function ingest(projectId: number, events: Sent[]): Promise<void> {
  await processMessages(
    events.map(({ index, name, at = NOW, environment = "production" }) =>
      message({
        projectId,
        index,
        receivedAt: at,
        event: { ...errorEvent(name), environment, timestamp: at / 1000 },
      }),
    ),
    consumerDeps(),
  );
}

async function issuesOf(projectId: number, query = ""): Promise<ApiIssueList> {
  const response = await api(`/organizations/default/issues/?project=${projectId}${query}`);

  return response.json<ApiIssueList>();
}

describe("session and scoping", () => {
  it("creates the user on first sight and lists their organization", async () => {
    const me = await (await api("/me/")).json<ApiMe>();

    expect(me.email).toBe("dev@example.com");
    expect(me.organizations).toEqual([{ id: 1, slug: "default", name: "Default" }]);
  });

  it("does not re-add a user who was removed from the organization", async () => {
    const email = "removed@example.com";

    // Each call is a new session (as on a fresh isolate) at a later time.
    const call = (now = NOW): Promise<Response> =>
      handleApi(
        new Request("https://zentry.test/api/0/me/", {
          headers: { "cf-access-jwt-assertion": token },
        }),
        apiDeps({ now: () => now }),
        new Sessions(),
      );

    const token = await signToken(claims({ email }));

    expect((await (await call()).json<ApiMe>()).organizations).toHaveLength(1);

    await env.DB.prepare(
      `DELETE FROM organization_members
       WHERE user_id = (SELECT id FROM users WHERE email = ?1)`,
    )
      .bind(email)
      .run();

    expect((await (await call(NOW + 60_000)).json<ApiMe>()).organizations).toEqual([]);
  });

  it("answers 404 for an organization the user is not a member of", async () => {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO organizations (id, slug, name, created_at) VALUES (2, 'other', 'Other', 0)`,
    ).run();

    expect((await api("/organizations/other/issues/")).status).toBe(404);
    expect((await api("/organizations/nope/projects/")).status).toBe(404);
  });

  it("does not show an issue that belongs to another organization", async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO organizations (id, slug, name, created_at) VALUES (2, 'other', 'Other', 0)`,
      ),
      env.DB.prepare(
        `INSERT INTO projects (id, organization_id, slug, name, created_at) VALUES (9001, 2, 'secret', 'Secret', 0)`,
      ),
      env.DB.prepare(
        `INSERT INTO groups (id, project_id, short_id, primary_hash, title, first_seen, last_seen, created_at)
         VALUES (9001, 9001, 1, 'h', 'Hidden', 0, 0, 0)`,
      ),
    ]);

    expect((await api("/organizations/default/issues/9001/")).status).toBe(404);
    expect((await api("/organizations/default/issues/9001/events/")).status).toBe(404);

    const changed = await api("/organizations/default/issues/?id=9001", {
      method: "PUT",
      body: { status: "resolved" },
    });

    const row = await env.DB.prepare(`SELECT status FROM groups WHERE id = 9001`).first<{
      status: string;
    }>();

    expect(changed.status).toBe(204);
    expect(row?.status).toBe("unresolved");
  });
});

describe("projects and keys", () => {
  it("creates a project with a first key and a DSN", async () => {
    const project = await newProject("Billing API");
    const keys = await (await api(`/projects/default/${project.slug}/keys/`)).json<ApiKey[]>();

    expect(project.slug).toBe("billing-api");
    expect(keys).toHaveLength(1);
    expect(keys[0]?.dsn).toBe(`https://${keys[0]?.publicKey}@ingest.zentry.test/${project.id}`);
  });

  it("refuses a body that is not JSON, or has a field of the wrong type", async () => {
    const path = "/organizations/default/projects/";

    const notJson = await handleApi(
      new Request(`https://zentry.test/api/0${path}`, {
        method: "POST",
        headers: { "cf-access-jwt-assertion": await signToken(claims()) },
        body: "name=oops",
      }),
      apiDeps(),
      new Sessions(),
    );

    const wrongType = await api(path, { method: "POST", body: { name: 42 } });

    expect(notJson.status).toBe(400);
    expect(wrongType.status).toBe(400);
    expect((await wrongType.json<{ detail: string }>()).detail).toContain("name");
  });

  it("refuses a duplicate slug and a missing name", async () => {
    await newProject("Dup One");

    const again = await api("/organizations/default/projects/", {
      method: "POST",
      body: { name: "Dup One" },
    });

    const empty = await api("/organizations/default/projects/", { method: "POST", body: {} });

    expect(again.status).toBe(400);
    expect(empty.status).toBe(400);
  });

  it("renames, sets the quota, and revokes a key", async () => {
    const project = await newProject("Rename Me");
    const path = `/projects/default/${project.slug}`;

    const updated = await api(`${path}/`, {
      method: "PUT",
      body: { name: "Renamed", maxEventsPerHour: 500 },
    });

    const [key] = await (await api(`${path}/keys/`)).json<ApiKey[]>();

    const revoked = await api(`${path}/keys/${key?.id}/`, {
      method: "PUT",
      body: { status: "revoked" },
    });

    expect(await updated.json<ApiProject>()).toMatchObject({
      name: "Renamed",
      maxEventsPerHour: 500,
    });
    expect((await revoked.json<ApiKey>()).status).toBe("revoked");
  });

  it("lifts the current rate limit when the quota changes", async () => {
    const project = await newProject("Quota Lift");
    const path = `/projects/default/${project.slug}/`;

    const limitedUntil = (): Promise<number | null> =>
      env.DB.prepare(`SELECT rate_limited_until AS until FROM projects WHERE id = ?1`)
        .bind(project.id)
        .first<{ until: number | null }>()
        .then((row) => row?.until ?? null);

    await api(path, { method: "PUT", body: { maxEventsPerHour: 10 } });
    await env.DB.prepare(
      `UPDATE projects SET rate_limited_until = 123, rate_limit_reason = 'project_quota' WHERE id = ?1`,
    )
      .bind(project.id)
      .run();

    // A rename leaves the limit alone; a new quota clears it.
    await api(path, { method: "PUT", body: { name: "Still Limited" } });
    expect(await limitedUntil()).toBe(123);

    await api(path, { method: "PUT", body: { maxEventsPerHour: 1000 } });
    expect(await limitedUntil()).toBeNull();
  });

  it("gives a new project the spike floor, so it is protected from its first event", async () => {
    const project = await newProject("Fresh");
    const response = await api("/organizations/default/limits/");
    const limits = await response.json<ApiOrganizationLimits>();
    const counted = env.DB.prepare(`SELECT count(*) AS n FROM projects WHERE organization_id = 1`);
    const { n } = (await counted.first<{ n: number }>()) ?? { n: 0 };

    expect(project.spikeLimitPerHour).toBe(spikeFloor(limits.maxEventsPerMonth, n));
  });

  it("lets an owner, and only an owner, change the monthly cap", async () => {
    // USER is the first user, so the owner; anyone after is a member.
    const member = "member@example.com";

    expect(await (await api("/organizations/default/limits/")).json()).toMatchObject({
      maxEventsPerMonth: 1_000_000,
      canEdit: true,
    });

    const refused = await api("/organizations/default/limits/", {
      method: "PUT",
      body: { maxEventsPerMonth: 5 },
      email: member,
    });

    const changed = await api("/organizations/default/limits/", {
      method: "PUT",
      body: { maxEventsPerMonth: 2_000_000 },
    });

    const invalid = await api("/organizations/default/limits/", {
      method: "PUT",
      body: { maxEventsPerMonth: 0 },
    });

    expect(refused.status).toBe(403);
    expect(await changed.json()).toMatchObject({ maxEventsPerMonth: 2_000_000 });
    expect(invalid.status).toBe(400);

    expect(
      await (await api("/organizations/default/limits/", { email: member })).json(),
    ).toMatchObject({ maxEventsPerMonth: 2_000_000, canEdit: false });

    await api("/organizations/default/limits/", {
      method: "PUT",
      body: { maxEventsPerMonth: 1_000_000 },
    });
  });

  it("turns spike protection off and lifts a spike limit", async () => {
    const project = await newProject("Bursty");
    const path = `/projects/default/${project.slug}/`;

    expect(project.spikeProtection).toBe(true);

    await env.DB.prepare(
      `UPDATE projects SET rate_limited_until = 123, rate_limit_reason = 'spike_protection'
       WHERE id = ?1`,
    )
      .bind(project.id)
      .run();

    expect((await (await api(path)).json<ApiProject>()).rateLimit).toEqual({
      until: 123,
      reason: "spike_protection",
    });

    const updated = await (
      await api(path, { method: "PUT", body: { spikeProtection: false } })
    ).json<ApiProject>();

    expect(updated).toMatchObject({ spikeProtection: false, rateLimit: null });
  });
  it("reports 24-hour counts in the project list", async () => {
    const project = await newProject("Counted");

    await ingest(project.id, [
      { index: 1, name: "a" },
      { index: 2, name: "a" },
    ]);

    const projects = await (await api("/organizations/default/projects/")).json<ApiProject[]>();
    const found = projects.find((candidate) => candidate.id === project.id);

    expect(found?.events24h).toBe(2);
    expect(found?.stats).toHaveLength(24);
  });
});

describe("issues", () => {
  it("lists issues newest first with a short id and a sparkline", async () => {
    const project = await newProject("Lister");

    await ingest(project.id, [
      { index: 1, name: "older", at: NOW - 60_000 },
      { index: 2, name: "newer", at: NOW },
      { index: 3, name: "newer", at: NOW },
    ]);

    const { issues, nextCursor } = await issuesOf(project.id);

    expect(issues.map((issue) => [issue.shortId, issue.timesSeen])).toEqual([
      ["LISTER-2", 2],
      ["LISTER-1", 1],
    ]);

    expect(issues[0]?.metadata).toMatchObject({
      type: "ValueError",
      value: "boom",
      function: "newer",
    });
    expect(issues[0]?.stats.at(-1)?.[1]).toBe(2);
    expect(nextCursor).toBeNull();
  });

  it("pages with a cursor", async () => {
    const project = await newProject("Pager");

    await ingest(
      project.id,
      [1, 2, 3].map((index) => ({ index, name: `f${index}`, at: NOW - index * 1000 })),
    );

    const first = await issuesOf(project.id, "&limit=2");
    const second = await issuesOf(project.id, `&limit=2&cursor=${first.nextCursor}`);

    expect(first.issues.map((issue) => issue.shortId)).toEqual(["PAGER-1", "PAGER-2"]);
    expect(second.issues.map((issue) => issue.shortId)).toEqual(["PAGER-3"]);
    expect(second.nextCursor).toBeNull();
  });

  it("filters by tag, by text and by status", async () => {
    const project = await newProject("Filter");

    await ingest(project.id, [
      { index: 1, name: "checkout", environment: "staging" },
      { index: 2, name: "refund", environment: "production" },
    ]);

    const staging = await issuesOf(project.id, "&tag=environment:staging");
    const text = await issuesOf(project.id, "&query=refund");
    const resolved = await issuesOf(project.id, "&status=resolved");

    expect(staging.issues.map((issue) => issue.metadata.function)).toEqual(["checkout"]);
    expect(text.issues.map((issue) => issue.metadata.function)).toEqual(["refund"]);
    expect(resolved.issues).toEqual([]);
  });

  it("refuses query parameters that do not match, saying which one", async () => {
    const project = await newProject("Strict");

    for (const query of [
      "&limit=many",
      "&limit=0",
      "&status=nonsense",
      "&tag=nocolon",
      "&cursor=%%",
    ]) {
      const response = await api(`/organizations/default/issues/?project=${project.id}${query}`);

      expect({ query, status: response.status }).toEqual({ query, status: 400 });
    }

    const response = await api(`/organizations/default/issues/?project=${project.id}&sort=wrong`);

    expect((await response.json<{ detail: string }>()).detail).toContain("sort");
  });

  it("treats an empty query parameter as absent", async () => {
    const project = await newProject("Empty Params");
    const response = await api(`/organizations/default/issues/?project=${project.id}&cursor=&tag=`);

    expect(response.status).toBe(200);
  });

  it("marks an issue as seen per user, and unseen again when it regresses", async () => {
    const project = await newProject("Seen");
    const earlier = NOW - 60_000;

    await ingest(project.id, [{ index: 1, name: "checkout", at: earlier }]);

    const [issue] = (await issuesOf(project.id)).issues;
    const path = `/organizations/default/issues/${issue?.id}/`;

    const seenBy = async (email: string): Promise<boolean | undefined> =>
      (await (await api(path, { email })).json<ApiIssue>()).hasSeen;

    expect(issue?.hasSeen).toBe(false);

    const opened = await api(path, { method: "PUT", body: { hasSeen: true } });

    expect((await opened.json<ApiIssue>()).hasSeen).toBe(true);
    expect((await issuesOf(project.id)).issues[0]?.hasSeen).toBe(true);
    // Another user has not opened it.
    expect(await seenBy("colleague@example.com")).toBe(false);

    // Resolved, then it happens again: unread once more for the user who had seen it.
    await api(path, { method: "PUT", body: { status: "resolved" } });
    await ingest(project.id, [{ index: 2, name: "checkout", at: NOW + 1000 }]);

    expect(await seenBy(USER)).toBe(false);
  });

  it("refuses an update that changes nothing", async () => {
    const project = await newProject("Empty Update");

    await ingest(project.id, [{ index: 1, name: "checkout" }]);

    const [issue] = (await issuesOf(project.id)).issues;
    const path = `/organizations/default/issues/${issue?.id}/`;

    expect((await api(path, { method: "PUT", body: {} })).status).toBe(400);
    expect((await api(path, { method: "PUT", body: { hasSeen: false } })).status).toBe(400);
  });

  it("resolves an issue, records who did it, and reopens it", async () => {
    const project = await newProject("Resolver");

    await ingest(project.id, [{ index: 1, name: "checkout" }]);

    const [issue] = (await issuesOf(project.id)).issues;
    const path = `/organizations/default/issues/${issue?.id}`;

    const resolved = await (
      await api(`${path}/`, { method: "PUT", body: { status: "resolved" } })
    ).json<ApiIssue>();

    const activity = await (await api(`${path}/activity/`)).json<ApiActivity[]>();

    const reopened = await (
      await api(`${path}/`, { method: "PUT", body: { status: "unresolved" } })
    ).json<ApiIssue>();

    const invalid = await api(`${path}/`, { method: "PUT", body: { status: "nonsense" } });

    expect(resolved).toMatchObject({ status: "resolved", resolvedAt: NOW });
    expect(activity).toMatchObject([{ type: "resolved", userEmail: "dev@example.com" }]);
    expect(reopened).toMatchObject({ status: "unresolved", resolvedAt: null });
    expect(invalid.status).toBe(400);
  });

  it("changes several issues at once", async () => {
    const project = await newProject("Bulk");

    await ingest(project.id, [
      { index: 1, name: "a" },
      { index: 2, name: "b" },
    ]);

    const ids = (await issuesOf(project.id)).issues.map((issue) => `id=${issue.id}`).join("&");

    await api(`/organizations/default/issues/?${ids}`, {
      method: "PUT",
      body: { status: "ignored" },
    });

    expect((await issuesOf(project.id, "&status=ignored")).issues).toHaveLength(2);
  });

  it("returns tags, stats and the short id lookup", async () => {
    const project = await newProject("Detail");

    await ingest(project.id, [
      { index: 1, name: "checkout", environment: "staging" },
      { index: 2, name: "checkout", environment: "production" },
      { index: 3, name: "checkout", environment: "production" },
    ]);

    const [issue] = (await issuesOf(project.id)).issues;
    const path = `/organizations/default/issues/${issue?.id}`;
    const tags = await (await api(`${path}/tags/`)).json<ApiTag[]>();
    const stats = await (await api(`${path}/stats/?period=14d`)).json<ApiIssueStats>();

    const byShortId = await (
      await api("/organizations/default/shortids/detail-1/")
    ).json<ApiIssue>();

    expect(tags.find((tag) => tag.key === "environment")).toEqual({
      key: "environment",
      total: 3,
      values: [
        { value: "production", count: 2 },
        { value: "staging", count: 1 },
      ],
    });

    expect(stats).toMatchObject({ total: 3, stored: 3 });
    expect(stats.points).toHaveLength(14);
    expect(byShortId.id).toBe(issue?.id);
  });
});

describe("events", () => {
  it("lists an issue's events and walks between them", async () => {
    const project = await newProject("Walker");

    await ingest(
      project.id,
      [1, 2, 3].map((index) => ({ index, name: "checkout", at: NOW - (3 - index) * 1000 })),
    );

    const [issue] = (await issuesOf(project.id)).issues;
    const path = `/organizations/default/issues/${issue?.id}/events`;
    const list = await (await api(`${path}/?limit=2`)).json<ApiEventList>();
    const latest = await (await api(`${path}/latest/`)).json<ApiEventDetail>();
    const middle = await (await api(`${path}/${eventId(2)}/`)).json<ApiEventDetail>();
    const oldest = await (await api(`${path}/oldest/`)).json<ApiEventDetail>();

    expect(list.events.map((event) => event.eventId)).toEqual([eventId(3), eventId(2)]);
    expect(list.nextCursor).not.toBeNull();
    expect(latest).toMatchObject({ previousEventId: eventId(2), nextEventId: null });
    expect(latest.event).toMatchObject({ eventId: eventId(3), title: "ValueError: boom" });
    expect(middle).toMatchObject({ previousEventId: eventId(1), nextEventId: eventId(3) });
    expect(oldest).toMatchObject({ previousEventId: null, nextEventId: eventId(2) });
    expect((await api(`${path}/${eventId(99)}/`)).status).toBe(404);
  });

  it("deletes an issue together with its stored events", async () => {
    const project = await newProject("Deleter");

    await ingest(project.id, [{ index: 1, name: "checkout" }]);

    const [issue] = (await issuesOf(project.id)).issues;
    const deleted = await api(`/organizations/default/issues/${issue?.id}/`, { method: "DELETE" });

    expect(deleted.status).toBe(204);
    expect((await issuesOf(project.id, "&status=all")).issues).toEqual([]);
    expect(await new EventBlobs(env.BLOBS).getJson(project.id, eventId(1))).toBeNull();
  });
});
