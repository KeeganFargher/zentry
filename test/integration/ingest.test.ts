import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { SpillStore } from "@/blobs/spill";
import { KeyStore } from "@/db/keys";
import { ProjectStore } from "@/db/projects";
import { UsageStore } from "@/db/usage";
import { KeyCache } from "@/ingest/auth";
import { handleIngest, matchIngestRoute } from "@/ingest/handler";
import type { IngestDeps } from "@/ingest/handler";
import { UsageCache } from "@/ingest/limits";
import { monthBucket, nextMonthBucket, SECOND } from "@/shared/time";
import type { QueueMessage } from "@/shared/types";

import { createOrganization, createProject, NOW } from "./helpers";

type Harness = { deps: IngestDeps; sent: QueueMessage[] };

function harness(overrides: Partial<IngestDeps> = {}): Harness {
  const keyStore = new KeyStore(env.DB);
  const usageStore = new UsageStore(env.DB);
  const spill = new SpillStore(env.BLOBS);
  const sent: QueueMessage[] = [];

  return {
    sent,
    deps: {
      keys: new KeyCache((publicKey) => keyStore.findActive(publicKey)),
      usage: new UsageCache((organization, month) => usageStore.received(organization, month)),
      allow: async () => true,
      spill: (projectId, eventId, payload) => spill.put(projectId, eventId, payload),
      send: async (message) => {
        sent.push(message);
      },
      now: () => NOW,
      ...overrides,
    },
  };
}

async function projectWithKey(organizationId = 1): Promise<{ id: number; key: string }> {
  const project = await createProject(null, organizationId);
  const [key] = await new ProjectStore(env.DB).listKeys(project.id);

  return { id: project.id, key: key?.publicKey ?? "" };
}

async function post(url: string, init: RequestInit, deps: IngestDeps): Promise<Response> {
  const request = new Request(url, { method: "POST", ...init });
  const route = matchIngestRoute(new URL(url));

  if (route === null) {
    throw new Error(`not an ingest route: ${url}`);
  }

  return handleIngest(request, route, deps);
}

function envelope(header: string, event: string): string {
  return `${header}\n{"type":"event"}\n${event}\n`;
}

async function gzip(text: string): Promise<ArrayBuffer> {
  return new Response(
    new Blob([text]).stream().pipeThrough(new CompressionStream("gzip")),
  ).arrayBuffer();
}

const EVENT_ID = "9ec79c33ec9942ab8353589fcb2e04dc";

describe("ingest routing", () => {
  it("matches envelope and store paths with or without a trailing slash", () => {
    expect(matchIngestRoute(new URL("https://i.test/api/12/envelope/"))).toEqual({
      projectId: 12,
      kind: "envelope",
    });

    expect(matchIngestRoute(new URL("https://i.test/api/12/store"))).toEqual({
      projectId: 12,
      kind: "store",
    });
  });

  it("does not match the read API or anything else", () => {
    expect(matchIngestRoute(new URL("https://i.test/api/0/organizations/x/issues/"))).toBeNull();
    expect(matchIngestRoute(new URL("https://i.test/api/12/security/"))).toBeNull();
    expect(matchIngestRoute(new URL("https://i.test/"))).toBeNull();
  });
});

describe("ingest authentication", () => {
  it("accepts the key from the X-Sentry-Auth header", async () => {
    const project = await projectWithKey();
    const { deps, sent } = harness();

    const response = await post(
      `https://i.test/api/${project.id}/envelope/`,
      {
        headers: { "x-sentry-auth": `Sentry sentry_key=${project.key}, sentry_version=7` },
        body: envelope(`{"event_id":"${EVENT_ID}"}`, '{"message":"hi"}'),
      },
      deps,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: EVENT_ID });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ project_id: project.id, event_id: EVENT_ID, received_at: NOW });
  });

  it("accepts the key from the query string", async () => {
    const project = await projectWithKey();
    const { deps, sent } = harness();

    const response = await post(
      `https://i.test/api/${project.id}/envelope/?sentry_key=${project.key}&sentry_version=7`,
      { body: envelope("{}", '{"message":"hi"}') },
      deps,
    );

    expect(response.status).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it("accepts the key from the envelope's dsn", async () => {
    const project = await projectWithKey();
    const { deps, sent } = harness();
    const header = `{"dsn":"https://${project.key}@i.test/${project.id}","sent_at":"2026-11-17T10:30:00Z"}`;

    const response = await post(
      `https://i.test/api/${project.id}/envelope/`,
      { body: envelope(header, '{"message":"hi"}') },
      deps,
    );

    expect(response.status).toBe(200);
    expect(sent[0]?.sent_at).toBe("2026-11-17T10:30:00Z");
  });

  it("refuses a missing key, an unknown key, and a key for another project", async () => {
    const project = await projectWithKey();
    const other = await projectWithKey();
    const { deps, sent } = harness();
    const body = envelope("{}", '{"message":"hi"}');

    const statusFor = async (url: string): Promise<number> =>
      (await post(url, { body }, deps)).status;

    expect(await statusFor(`https://i.test/api/${project.id}/envelope/`)).toBe(401);

    expect(
      await statusFor(`https://i.test/api/${project.id}/envelope/?sentry_key=${"f".repeat(32)}`),
    ).toBe(401);

    expect(
      await statusFor(`https://i.test/api/${project.id}/envelope/?sentry_key=${other.key}`),
    ).toBe(401);
    expect(sent).toEqual([]);
  });

  it("refuses a revoked key", async () => {
    const project = await projectWithKey();
    const projects = new ProjectStore(env.DB);
    const [key] = await projects.listKeys(project.id);

    await projects.updateKey({
      projectId: project.id,
      keyId: key?.id ?? 0,
      label: "x",
      status: "revoked",
    });

    const response = await post(
      `https://i.test/api/${project.id}/store/?sentry_key=${project.key}`,
      { body: '{"message":"hi"}' },
      harness().deps,
    );

    expect(response.status).toBe(401);
  });
});

describe("ingest bodies", () => {
  it("accepts the legacy store endpoint and assigns an event id", async () => {
    const project = await projectWithKey();
    const { deps, sent } = harness();

    const response = await post(
      `https://i.test/api/${project.id}/store/?sentry_key=${project.key}`,
      { body: '{"message":"hi"}' },
      deps,
    );

    const body = await response.json<{ id: string }>();

    expect(body.id).toMatch(/^[0-9a-f]{32}$/);
    expect(sent[0]?.event_id).toBe(body.id);
    expect(sent[0]?.payload).toBe('{"message":"hi"}');
  });

  it("normalizes a dashed, upper-case event id", async () => {
    const project = await projectWithKey();
    const { deps, sent } = harness();

    await post(
      `https://i.test/api/${project.id}/store/?sentry_key=${project.key}`,
      { body: '{"event_id":"9EC79C33-EC99-42AB-8353-589FCB2E04DC"}' },
      deps,
    );

    expect(sent[0]?.event_id).toBe(EVENT_ID);
  });

  it("decodes a gzip body", async () => {
    const project = await projectWithKey();
    const { deps, sent } = harness();

    const response = await post(
      `https://i.test/api/${project.id}/envelope/?sentry_key=${project.key}`,
      {
        headers: { "content-encoding": "gzip" },
        body: await gzip(envelope("{}", '{"message":"compressed"}')),
      },
      deps,
    );

    expect(response.status).toBe(200);
    expect(sent[0]?.payload).toBe('{"message":"compressed"}');
  });

  it("answers 200 with an empty body when nothing is kept", async () => {
    const project = await projectWithKey();
    const { deps, sent } = harness();
    const url = `https://i.test/api/${project.id}/envelope/?sentry_key=${project.key}`;
    const session = await post(url, { body: '{}\n{"type":"session"}\n{"sid":"1"}\n' }, deps);
    const transaction = await post(url, { body: envelope("{}", '{"type":"transaction"}') }, deps);

    expect([session.status, await session.json()]).toEqual([200, {}]);
    expect([transaction.status, await transaction.json()]).toEqual([200, {}]);
    expect(sent).toEqual([]);
  });

  it("refuses malformed input, unknown encodings and oversize bodies", async () => {
    const project = await projectWithKey();
    const { deps } = harness();
    const url = `https://i.test/api/${project.id}/envelope/?sentry_key=${project.key}`;

    const statusFor = async (init: RequestInit): Promise<number> =>
      (await post(url, init, deps)).status;

    expect(await statusFor({ body: "not an envelope" })).toBe(400);
    expect(await statusFor({ body: envelope("{}", "[1,2]") })).toBe(400);
    expect(await statusFor({ body: "x", headers: { "content-encoding": "zstd" } })).toBe(415);
    expect(await statusFor({ body: "x".repeat(10_000_001) })).toBe(413);

    expect(
      await statusFor({
        body: await gzip("x".repeat(11_000_000)),
        headers: { "content-encoding": "gzip" },
      }),
    ).toBe(413);
  });

  it("keeps an event that arrives with a large attachment, and refuses an oversize event", async () => {
    const project = await projectWithKey();
    const { deps, sent } = harness();
    const url = `https://i.test/api/${project.id}/envelope/?sentry_key=${project.key}`;
    const event = JSON.stringify({ event_id: EVENT_ID, message: "with a screenshot" });
    const attachment = "z".repeat(3_000_000);

    const withAttachment = [
      "{}",
      `{"type":"event","length":${event.length}}`,
      event,
      `{"type":"attachment","length":${attachment.length},"filename":"screen.png"}`,
      attachment,
    ].join("\n");

    expect((await post(url, { body: withAttachment }, deps)).status).toBe(200);
    expect(sent).toHaveLength(1);

    const huge = JSON.stringify({ message: "m".repeat(1_000_001) });

    expect((await post(url, { body: envelope("{}", huge) }, deps)).status).toBe(413);
    expect(sent).toHaveLength(1);
  });

  it("spills an event that is too large for a queue message", async () => {
    const project = await projectWithKey();
    const { deps, sent } = harness();
    const payload = JSON.stringify({ message: "big", extra: { blob: "y".repeat(150_000) } });

    await post(
      `https://i.test/api/${project.id}/store/?sentry_key=${project.key}`,
      { body: payload },
      deps,
    );

    const [message] = sent;

    expect(message?.payload).toBeNull();
    expect(await new SpillStore(env.BLOBS).get(message?.spill_key ?? "")).toBe(payload);
  });
});

describe("ingest limits and CORS", () => {
  it("answers the CORS preflight and puts CORS headers on errors", async () => {
    const { deps } = harness();
    const preflight = await post("https://i.test/api/1/envelope/", { method: "OPTIONS" }, deps);
    const refused = await post("https://i.test/api/1/envelope/", { body: "{}\n" }, deps);

    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-headers")).toContain("x-sentry-auth");
    expect(refused.status).toBe(401);
    expect(refused.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("returns 429 with SDK back-off headers while a project is over quota", async () => {
    const project = await projectWithKey();

    await env.DB.prepare(
      `UPDATE projects SET rate_limited_until = ?2, rate_limit_reason = 'spike_protection'
       WHERE id = ?1`,
    )
      .bind(project.id, NOW + 90_000)
      .run();

    const { deps, sent } = harness();

    const response = await post(
      `https://i.test/api/${project.id}/store/?sentry_key=${project.key}`,
      { body: '{"message":"hi"}' },
      deps,
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("90");
    expect(response.headers.get("x-sentry-rate-limits")).toBe("90::project:spike_protection");
    expect(sent).toEqual([]);
  });

  it("refuses an organization's projects once its month's cap is reached", async () => {
    const organization = await createOrganization(5);
    const project = await projectWithKey(organization);
    const other = await projectWithKey();
    const { deps, sent } = harness();

    await env.DB.prepare(
      `INSERT INTO usage_months (organization_id, month, received) VALUES (?1, ?2, 5)`,
    )
      .bind(organization, monthBucket(NOW))
      .run();

    // Another organization's cap is its own.
    const unaffected = await post(
      `https://i.test/api/${other.id}/store/?sentry_key=${other.key}`,
      { body: '{"message":"hi"}' },
      deps,
    );

    expect(unaffected.status).toBe(200);
    sent.length = 0;

    const response = await post(
      `https://i.test/api/${project.id}/store/?sentry_key=${project.key}`,
      { body: '{"message":"hi"}' },
      deps,
    );

    const wait = String((nextMonthBucket(NOW) - NOW) / SECOND);

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe(wait);
    expect(response.headers.get("x-sentry-rate-limits")).toBe(`${wait}::organization:org_quota`);
    expect(sent).toEqual([]);
  });

  it("returns 429 when the burst limiter refuses", async () => {
    const project = await projectWithKey();
    const { deps } = harness({ allow: async () => false });

    const response = await post(
      `https://i.test/api/${project.id}/store/?sentry_key=${project.key}`,
      { body: '{"message":"hi"}' },
      deps,
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(response.headers.get("x-sentry-rate-limits")).toBe("60::key:key_quota");
  });

  it("returns 503 when the queue is unavailable", async () => {
    const project = await projectWithKey();

    const { deps } = harness({
      send: async () => {
        throw new Error("queue down");
      },
    });

    const response = await post(
      `https://i.test/api/${project.id}/store/?sentry_key=${project.key}`,
      { body: '{"message":"hi"}' },
      deps,
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("30");
  });

  it("refuses methods other than POST and OPTIONS", async () => {
    const response = await post(
      "https://i.test/api/1/envelope/",
      { method: "GET" },
      harness().deps,
    );

    expect(response.status).toBe(405);
  });

  it("does not rate-limit envelopes that carry no event", async () => {
    const project = await projectWithKey();
    const { deps } = harness({ allow: async () => false });
    const url = `https://i.test/api/${project.id}/envelope/?sentry_key=${project.key}`;
    const session = await post(url, { body: '{}\n{"type":"session"}\n{"sid":"1"}\n' }, deps);
    const transaction = await post(url, { body: envelope("{}", '{"type":"transaction"}') }, deps);
    const error = await post(url, { body: envelope("{}", '{"message":"hi"}') }, deps);

    // Tracing and session traffic must not make the SDK back off from errors.
    expect([session.status, transaction.status, error.status]).toEqual([200, 200, 429]);
  });

  it("spills a payload that would outgrow a queue message once escaped", async () => {
    const project = await projectWithKey();
    const { deps, sent } = harness();
    // 60 KB of quotes: under the inline limit raw, over it as a JSON string.
    const payload = JSON.stringify({ message: '"'.repeat(30_000) });

    const response = await post(
      `https://i.test/api/${project.id}/store/?sentry_key=${project.key}`,
      { body: payload },
      deps,
    );

    expect(response.status).toBe(200);
    expect(payload.length).toBeLessThan(100_000);
    expect(sent[0]?.payload).toBeNull();
    expect(sent[0]?.spill_key).not.toBeNull();
  });
});
