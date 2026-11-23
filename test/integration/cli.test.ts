// sentry-cli tokens and the Sentry-shaped API they reach (DESIGN.md §20).
// Requests go to the ingest host, where the CLI calls, with the token as a
// bearer, exactly as sentry-cli sends it.

import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { parseSearch } from "@/api/cli-search";
import { handleApi, Sessions } from "@/api/router";
import { processMessages } from "@/consumer/handler";
import type {
  ApiCliTokenCreated,
  ApiCliTokenList,
  ApiMonitor,
  ApiPaired,
  ApiPairing,
  Json,
} from "@/shared/contract";
import { HOUR, MINUTE } from "@/shared/time";

import { api, apiDeps, USER } from "./api-helpers";
import { consumerDeps, createProject, errorEvent, message, NOW } from "./helpers";

const INGEST = "https://ingest.zentry.test";

type Call = { method?: string; body?: Json; token: string; now?: number };

/** Calls the API on the ingest host as sentry-cli does. */
async function cli(path: string, call: Call): Promise<Response> {
  const init: RequestInit = {
    method: call.method ?? "GET",
    headers: { authorization: `Bearer ${call.token}` },
  };

  if (call.body !== undefined) {
    init.body = JSON.stringify(call.body);
  }

  const now = call.now ?? NOW;

  return handleApi(
    new Request(`${INGEST}/api/0${path}`, init),
    apiDeps({ now: () => now }),
    new Sessions(),
  );
}

/** A phone's device token, signed in through a pairing code as the app does. */
async function deviceToken(): Promise<string> {
  const pairing = await (await api("/me/pairings/", { method: "POST" })).json<ApiPairing>();
  const code = new URL(pairing.link).searchParams.get("code") ?? "";

  const paired = await handleApi(
    new Request(`${INGEST}/api/0/pair/`, {
      method: "POST",
      body: JSON.stringify({ code, name: "Pixel" }),
    }),
    apiDeps(),
    new Sessions(),
  );

  return (await paired.json<ApiPaired>()).token;
}

async function makeToken(email = USER): Promise<ApiCliTokenCreated> {
  const response = await api("/organizations/default/cli-tokens/", {
    method: "POST",
    body: { name: "CI" },
    email,
  });

  expect(response.status).toBe(201);

  return response.json<ApiCliTokenCreated>();
}

type TokenPayload = { iat: number; url: string; region_url: string; org: string };

/** The `{iat, url, org}` sentry-cli reads out of the token's middle segment. */
async function payloadOf(token: string): Promise<TokenPayload> {
  const [, payload = ""] = token.split("_");

  return new Response(atob(payload)).json<TokenPayload>();
}

const NO_METADATA = '{"type":null,"value":null,"filename":null,"function":null,"logger":null}';

/** `count` plain issues straight into D1, newest last; faster than ingesting each. */
async function seedIssues(projectId: number, count: number): Promise<void> {
  await env.DB.prepare(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2)
     INSERT INTO groups (project_id, short_id, primary_hash, title, culprit, level, metadata,
                         status, times_seen, first_seen, last_seen, created_at)
     SELECT ?1, i, 'hash-' || i, 'Bulk ' || i, '', 'error', ?4, 'unresolved', 1, ?3, ?3 + i, ?3
     FROM n`,
  )
    .bind(projectId, count, NOW, NO_METADATA)
    .run();
}

async function idsOf(projectId: number): Promise<number[]> {
  const { results } = await env.DB.prepare(
    `SELECT id FROM groups WHERE project_id = ?1 ORDER BY short_id`,
  )
    .bind(projectId)
    .all<{ id: number }>();

  return results.map((row) => row.id);
}

async function statusesOf(projectId: number): Promise<string[]> {
  const { results } = await env.DB.prepare(
    `SELECT status FROM groups WHERE project_id = ?1 ORDER BY short_id`,
  )
    .bind(projectId)
    .all<{ status: string }>();

  return results.map((row) => row.status);
}

/** The `Link` header's next cursor, read the way sentry-cli's pagination.rs does. */
function nextCursor(response: Response): string | null {
  const link = response.headers.get("link") ?? "";
  const results = /rel="next"; results="(\w+)"; cursor="([^"]*)"/.exec(link);

  return results?.[1] === "true" ? (results[2] ?? null) : null;
}

describe("making a token", () => {
  it("is in sentry-cli's org token shape, with the ingest URL and organization inside", async () => {
    const created = await makeToken();
    const [prefix, payload, secret, extra] = created.token.split("_");

    expect(prefix).toBe("sntrys");
    expect(extra).toBeUndefined();
    expect(await payloadOf(created.token)).toMatchObject({
      url: INGEST,
      region_url: INGEST,
      org: "default",
    });
    expect(created.url).toBe(INGEST);
    // sentry-cli insists on exactly 32 bytes of unpadded base64 (org_auth_token.rs).
    expect(secret).toMatch(/^[A-Za-z0-9+/]{43}$/);
    expect(atob(`${secret ?? ""}=`)).toHaveLength(32);
    expect(payload).not.toContain("_");
    expect(created.cliToken).toMatchObject({ name: "CI", hint: created.token.slice(-4) });
  });

  it("is listed by its hint only, and only to the member who made it", async () => {
    const created = await makeToken();
    const mine = await (await api("/organizations/default/cli-tokens/")).json<ApiCliTokenList>();

    expect(mine.tokens.map((token) => token.id)).toContain(created.cliToken.id);
    expect(JSON.stringify(mine)).not.toContain(created.token);

    const theirs = await api("/organizations/default/cli-tokens/", { email: "other@example.com" });

    expect((await theirs.json<ApiCliTokenList>()).tokens).toEqual([]);

    const revokeTheirs = await api(`/organizations/default/cli-tokens/${created.cliToken.id}/`, {
      method: "DELETE",
      email: "other@example.com",
    });

    expect(revokeTheirs.status).toBe(404);
  });

  it("cannot be done, listed or revoked by a phone", async () => {
    const token = await deviceToken();
    const { cliToken } = await makeToken();
    const base = `${INGEST}/api/0/organizations/default/cli-tokens/`;

    for (const [method, url] of [
      ["GET", base],
      ["POST", base],
      ["DELETE", `${base}${cliToken.id}/`],
    ] as const) {
      const response = await handleApi(
        new Request(url, {
          method,
          headers: { authorization: `Bearer ${token}` },
          body: method === "POST" ? JSON.stringify({ name: "phone" }) : null,
        }),
        apiDeps(),
        new Sessions(),
      );

      expect([method, response.status]).toEqual([method, 403]);
    }
  });

  it("cannot be done with a token", async () => {
    const { token } = await makeToken();

    const response = await cli("/organizations/default/cli-tokens/", {
      method: "POST",
      body: { name: "more" },
      token,
    });

    expect(response.status).toBe(501);
  });
});

describe("a token", () => {
  it("answers sentry-cli info with its member and scopes", async () => {
    const { token } = await makeToken();
    const response = await cli("/", { token });

    const info = await response.json<{ user: { id: string; email: string }; auth: object }>();

    expect(response.status).toBe(200);
    expect(info.user.email).toBe(USER);
    expect(info.user.id).toMatch(/^\d+$/);
    expect(info.auth).toEqual({
      scopes: ["org:read", "project:read", "event:read", "event:write"],
    });
  });

  it("reaches none of the web or app routes, which answer 501 to it", async () => {
    const { token } = await makeToken();

    for (const [method, path] of [
      ["GET", "/me/"],
      ["POST", "/me/pairings/"],
      ["GET", "/organizations/default/issues/"],
      ["POST", "/organizations/default/projects/"],
      ["GET", "/organizations/default/limits/"],
      ["POST", "/organizations/default/releases/"],
    ] as const) {
      expect([method, path, (await cli(path, { method, token })).status]).toEqual([
        method,
        path,
        501,
      ]);
    }
  });

  it("reaches only its own organization", async () => {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO organizations (id, slug, name, created_at) VALUES (2, 'other', 'Other', 0)`,
    ).run();

    const { token } = await makeToken();

    expect((await cli("/organizations/other/projects/", { token })).status).toBe(404);

    const organizations = await (await cli("/organizations/", { token })).json<object[]>();

    const created = await env.DB.prepare(
      `SELECT created_at AS at FROM organizations WHERE id = 1`,
    ).first<{ at: number }>();

    expect(organizations).toEqual([
      {
        id: "1",
        slug: "default",
        name: "Default",
        dateCreated: new Date(created?.at ?? Number.NaN).toISOString(),
        isEarlyAdopter: false,
        require2FA: false,
      },
    ]);
  });

  it("stops working once revoked, and once its member leaves", async () => {
    const created = await makeToken();

    await api(`/organizations/default/cli-tokens/${created.cliToken.id}/`, { method: "DELETE" });

    expect((await cli("/", { token: created.token })).status).toBe(401);

    const email = "leaver@example.com";
    const leaver = await makeToken(email);

    expect((await cli("/", { token: leaver.token })).status).toBe(200);

    await env.DB.prepare(
      `DELETE FROM organization_members WHERE user_id = (SELECT id FROM users WHERE email = ?1)`,
    )
      .bind(email)
      .run();

    expect((await cli("/", { token: leaver.token })).status).toBe(401);

    // The token went with the membership, so adding the member back does not revive it.
    await env.DB.prepare(
      `INSERT INTO organization_members (organization_id, user_id, created_at)
       SELECT 1, id, 0 FROM users WHERE email = ?1`,
    )
      .bind(email)
      .run();

    expect((await cli("/", { token: leaver.token })).status).toBe(401);
  });

  it("is refused when made up, rather than falling through to a device token", async () => {
    const response = await cli("/", { token: `sntrys_${btoa("{}")}_${"A".repeat(43)}` });

    expect(response.status).toBe(401);
  });

  it("records when it was last used", async () => {
    const created = await makeToken();

    await cli("/", { token: created.token });

    const { tokens } = await (
      await api("/organizations/default/cli-tokens/")
    ).json<ApiCliTokenList>();

    expect(tokens.find((token) => token.id === created.cliToken.id)?.lastUsedAt).toBe(NOW);
  });

  it("writes its last use at most hourly", async () => {
    const created = await makeToken();

    const lastUsed = async (): Promise<number | null | undefined> => {
      const list = await (await api("/organizations/default/cli-tokens/")).json<ApiCliTokenList>();

      return list.tokens.find((token) => token.id === created.cliToken.id)?.lastUsedAt;
    };

    await cli("/", { token: created.token });
    await cli("/", { token: created.token, now: NOW + 59 * MINUTE });

    expect(await lastUsed()).toBe(NOW);

    await cli("/", { token: created.token, now: NOW + HOUR });

    expect(await lastUsed()).toBe(NOW + HOUR);
  });
});

describe("projects and issues", () => {
  it("lists projects with string ids and no team", async () => {
    const { token } = await makeToken();
    const project = await createProject();

    const projects = await (
      await cli("/organizations/default/projects/", { token })
    ).json<{ id: string; slug: string; team: null }[]>();

    expect(projects).toContainEqual(
      expect.objectContaining({ id: String(project.id), slug: project.slug, team: null }),
    );
  });

  it("pages issues 100 at a time through the Link header, newest first", async () => {
    const { token } = await makeToken();
    const project = await createProject();

    await seedIssues(project.id, 101);

    const path = `/projects/default/${project.slug}/issues/?query=&cursor=`;
    const first = await cli(path, { token });
    const page = await first.json<{ id: string; shortId: string; lastSeen: string }[]>();

    expect(page).toHaveLength(100);
    expect(page[0]?.shortId).toBe(`${project.slug.toUpperCase()}-101`);
    expect(page[0]?.lastSeen).toBe(new Date(NOW + 101).toISOString());

    const cursor = nextCursor(first);

    expect(cursor).not.toBeNull();

    const second = await cli(
      `/projects/default/${project.slug}/issues/?query=&cursor=${encodeURIComponent(cursor ?? "")}`,
      { token },
    );

    expect(await second.json<{ shortId: string }[]>()).toEqual([
      expect.objectContaining({ shortId: `${project.slug.toUpperCase()}-1` }),
    ]);
    expect(nextCursor(second)).toBeNull();
  });

  it("answers Sentry search syntax, and refuses what it cannot answer", async () => {
    const { token } = await makeToken();
    const project = await createProject();

    await seedIssues(project.id, 2);
    await env.DB.prepare(
      `UPDATE groups SET status = 'ignored' WHERE project_id = ?1 AND short_id = 1`,
    )
      .bind(project.id)
      .run();

    const search = async (query: string): Promise<Response> =>
      cli(`/projects/default/${project.slug}/issues/?query=${encodeURIComponent(query)}`, {
        token,
      });

    expect(await (await search("is:muted")).json()).toEqual([
      expect.objectContaining({ title: "Bulk 1", status: "ignored" }),
    ]);
    expect(await (await search("is:unresolved Bulk 2")).json()).toHaveLength(1);
    expect(await (await search("")).json()).toHaveLength(2);
    expect(await (await search("is:archived")).json()).toHaveLength(1);
    expect(await (await search("level:error")).json()).toHaveLength(2);
    expect(await (await search("level:warning")).json()).toEqual([]);

    for (const refused of [
      "is:assigned",
      "!level:error",
      "level:bogus",
      "has:user",
      'message:"a b"',
    ]) {
      expect([refused, (await search(refused)).status]).toEqual([refused, 400]);
    }
  });

  it("is 404 for a project that is not there", async () => {
    const { token } = await makeToken();

    expect((await cli("/projects/default/nope/issues/", { token })).status).toBe(404);
  });
});

describe("changing issues in bulk", () => {
  async function change(projectSlug: string, query: string, status: string): Promise<Response> {
    const { token } = await makeToken();

    return cli(`/projects/default/${projectSlug}/issues/?${query}`, {
      method: "PUT",
      body: { status, snoozeDuration: null },
      token,
    });
  }

  it("resolves the issues named by id, as the token's member", async () => {
    const project = await createProject();

    await seedIssues(project.id, 3);

    const [first, second] = await idsOf(project.id);
    const response = await change(project.slug, `id=${first}&id=${second}`, "resolved");

    expect(response.status).toBe(200);
    expect(await statusesOf(project.id)).toEqual(["resolved", "resolved", "unresolved"]);

    const activity = await env.DB.prepare(
      `SELECT u.email FROM activity a JOIN users u ON u.id = a.user_id WHERE a.group_id = ?1`,
    )
      .bind(first)
      .first<{ email: string }>();

    expect(activity?.email).toBe(USER);
  });

  it("refuses, changing nothing, an id that is not this project's", async () => {
    const project = await createProject();
    const other = await createProject();

    await seedIssues(project.id, 1);
    await seedIssues(other.id, 1);

    const [own] = await idsOf(project.id);
    const [foreign] = await idsOf(other.id);
    const response = await change(project.slug, `id=${own}&id=${foreign}`, "resolved");

    expect(response.status).toBe(400);
    expect(await response.text()).toContain(String(foreign));
    expect(await statusesOf(project.id)).toEqual(["unresolved"]);
    expect(await statusesOf(other.id)).toEqual(["unresolved"]);
  });

  it("refuses an empty, misspelt or foreign filter rather than changing every issue", async () => {
    const project = await createProject();

    await seedIssues(project.id, 2);

    for (const query of ["id=", "status=", "ids=5", "query=is:unresolved"]) {
      expect([query, (await change(project.slug, query, "resolved")).status]).toEqual([query, 400]);
    }

    expect(await statusesOf(project.id)).toEqual(["unresolved", "unresolved"]);
  });

  it("mutes by status and reopens every issue with --all", async () => {
    const project = await createProject();

    await seedIssues(project.id, 2);

    expect((await change(project.slug, "status=unresolved", "muted")).status).toBe(200);
    expect(await statusesOf(project.id)).toEqual(["ignored", "ignored"]);

    expect((await change(project.slug, "", "unresolved")).status).toBe(200);
    expect(await statusesOf(project.id)).toEqual(["unresolved", "unresolved"]);
  });

  it("answers 204 when nothing matches, or nothing would change", async () => {
    const project = await createProject();

    expect((await change(project.slug, "status=resolved", "unresolved")).status).toBe(204);

    await seedIssues(project.id, 1);

    expect((await change(project.slug, "status=unresolved", "unresolved")).status).toBe(204);
  });

  it("refuses resolving in the next release and snoozing, which Zentry has not built", async () => {
    const project = await createProject();
    const { token } = await makeToken();

    await seedIssues(project.id, 1);

    expect((await change(project.slug, "", "resolvedInNextRelease")).status).toBe(400);

    const snooze = await cli(`/projects/default/${project.slug}/issues/`, {
      method: "PUT",
      body: { status: "muted", snoozeDuration: 60 },
      token,
    });

    expect(snooze.status).toBe(400);
    expect(await statusesOf(project.id)).toEqual(["unresolved"]);
  });

  it("refuses to change more than a thousand issues at once, changing none", async () => {
    const project = await createProject();

    await seedIssues(project.id, 1001);

    const response = await change(project.slug, "", "resolved");

    expect(response.status).toBe(400);
    expect(new Set(await statusesOf(project.id))).toEqual(new Set(["unresolved"]));
  });

  it("counts toward the thousand only the issues that would change", async () => {
    const project = await createProject();

    await seedIssues(project.id, 1001);
    await env.DB.prepare(
      `UPDATE groups SET status = 'resolved' WHERE project_id = ?1 AND short_id <= 2`,
    )
      .bind(project.id)
      .run();

    expect((await change(project.slug, "", "resolved")).status).toBe(200);
    expect(new Set(await statusesOf(project.id))).toEqual(new Set(["resolved"]));
  });
});

describe("events and monitors", () => {
  it("lists a project's events newest first", async () => {
    const { token } = await makeToken();
    const project = await createProject();

    await processMessages(
      [1, 2].map((index) =>
        message({
          projectId: project.id,
          index,
          receivedAt: NOW,
          event: { ...errorEvent(`f${index}`), timestamp: (NOW + index * 1000) / 1000 },
        }),
      ),
      consumerDeps(),
    );

    const response = await cli(`/projects/default/${project.slug}/events/?cursor=`, { token });
    const events = await response.json<{ eventID: string; dateCreated: string }[]>();

    expect(events.map((event) => event.dateCreated)).toEqual([
      new Date(NOW + 2000).toISOString(),
      new Date(NOW + 1000).toISOString(),
    ]);
    expect(events[0]?.eventID).toMatch(/^[0-9a-f]{32}$/);
    expect(nextCursor(response)).toBeNull();
  });

  it("pages a project's events past the first hundred", async () => {
    const { token } = await makeToken();
    const project = await createProject();

    await seedIssues(project.id, 1);

    const [groupId] = await idsOf(project.id);

    await env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 101)
       INSERT INTO events (project_id, event_id, group_id, ts, received_at, title)
       SELECT ?1, printf('%032x', i), ?2, ?3 + i, ?3, 'Event ' || i FROM n`,
    )
      .bind(project.id, groupId, NOW)
      .run();

    const path = `/projects/default/${project.slug}/events/`;
    const first = await cli(`${path}?cursor=`, { token });

    expect(await first.json()).toHaveLength(100);

    const cursor = nextCursor(first) ?? "";
    const second = await cli(`${path}?cursor=${encodeURIComponent(cursor)}`, { token });
    const oldest = "1".padStart(32, "0");

    expect(await second.json()).toEqual([
      {
        id: oldest,
        eventID: oldest,
        dateCreated: new Date(NOW + 1).toISOString(),
        title: "Event 1",
      },
    ]);
    expect(nextCursor(second)).toBeNull();
  });

  it("lists cron monitors only, a paused one as disabled", async () => {
    const { token } = await makeToken();
    const { id: projectId } = await createProject();
    const slug = `cli-${crypto.randomUUID().slice(0, 8)}`;

    const created = await api("/organizations/default/monitors/", {
      method: "POST",
      body: {
        projectId,
        type: "cron",
        name: "CLI-visible",
        config: { slug, schedule: { type: "crontab", crontab: "0 * * * *" } },
      },
    });

    expect(created.status).toBe(201);

    const cron = await created.json<ApiMonitor>();

    const paused = await api(`/organizations/default/monitors/${cron.id}/status/`, {
      method: "PUT",
      body: { version: cron.version, status: "paused" },
    });

    expect(paused.status).toBe(200);

    const metric = await api("/organizations/default/monitors/", {
      method: "POST",
      body: {
        projectId,
        type: "metric",
        name: "CLI-hidden metric",
        config: { windowSeconds: 300, threshold: 10 },
      },
    });

    expect(metric.status).toBe(201);

    const monitors = await (
      await cli("/organizations/default/monitors/", { token })
    ).json<{ slug: string; name: string; status: string }[]>();

    expect(monitors).toContainEqual({ id: cron.id, slug, name: "CLI-visible", status: "disabled" });
    expect(monitors.map((monitor) => monitor.name)).not.toContain("CLI-hidden metric");
  });
});

describe("parseSearch", () => {
  it("reads status, level, one tag and free text", () => {
    expect(parseSearch("is:resolved level:warning release:1.2 Type Error")).toEqual({
      status: "resolved",
      level: "warning",
      tag: ["release", "1.2"],
      text: "Type Error",
    });
  });

  it("keeps a word ending in a colon as text", () => {
    expect(parseSearch("TypeError: boom").text).toBe("TypeError: boom");
  });

  it("refuses a repeated status or level", () => {
    expect(() => parseSearch("is:resolved is:unresolved")).toThrow(/only once/);
    expect(() => parseSearch("level:error level:fatal")).toThrow(/only once/);
  });

  it("refuses Sentry keys that are not tags, and list or comparison values", () => {
    for (const query of ["assigned:me", "age:-24h", "timesSeen:>10", "level:[error,fatal]"]) {
      expect(() => parseSearch(query)).toThrow(/not supported/);
    }
  });

  it("refuses a second tag", () => {
    expect(() => parseSearch("a:1 b:2")).toThrow(/one tag/);
  });
});
