// Composition root: the only file that touches bindings. It builds the
// stores and hands typed functions to the four handlers.

import { AccessVerifier, fetchAccessKeys } from "@/api/access";
import type { ApiDeps } from "@/api/context";
import { handleApi, Sessions } from "@/api/router";
import { EventBlobs } from "@/blobs/events";
import { SpillStore } from "@/blobs/spill";
import { handleBatch } from "@/consumer/handler";
import type { ConsumerDeps } from "@/consumer/handler";
import { runRetention } from "@/cron/retention";
import type { RetentionDeps } from "@/cron/retention";
import { runSpikeProtection } from "@/cron/spike";
import type { SpikeDeps } from "@/cron/spike";
import { BatchStore } from "@/db/batch";
import { EventStore } from "@/db/events";
import { IssueStore } from "@/db/issues";
import { KeyStore } from "@/db/keys";
import { ProjectStore } from "@/db/projects";
import { RetentionStore } from "@/db/retention";
import { SpikeStore } from "@/db/spike";
import { TenancyStore } from "@/db/tenancy";
import { UsageStore } from "@/db/usage";
import { KeyCache } from "@/ingest/auth";
import { handleIngest, matchIngestRoute } from "@/ingest/handler";
import type { IngestDeps } from "@/ingest/handler";
import { UsageCache } from "@/ingest/limits";
import { errorText, logError } from "@/shared/log";
import type { QueueMessage } from "@/shared/types";

// Per-isolate caches, shared by every request the isolate serves.
let keyCache: KeyCache | undefined;
let usageCache: UsageCache | undefined;
let accessVerifier: AccessVerifier | undefined;
const sessions = new Sessions();

/**
 * A spend limit that is missing or mistyped must stop the Worker, not be read
 * as zero or as no limit: either would fail silently, one by refusing every
 * event, the other by removing the ceiling on the bill.
 */
function positiveInt(value: string, name: string): number {
  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got "${value}"`);
  }

  return parsed;
}

function ingestDeps(env: Env): IngestDeps {
  const keyStore = new KeyStore(env.DB);
  const spill = new SpillStore(env.BLOBS);

  const usageStore = new UsageStore(env.DB);

  keyCache ??= new KeyCache((publicKey) => keyStore.findActive(publicKey));
  usageCache ??= new UsageCache((month) => usageStore.received(month));

  return {
    keys: keyCache,
    usage: usageCache,
    maxEventsPerMonth: positiveInt(env.MAX_EVENTS_PER_MONTH, "MAX_EVENTS_PER_MONTH"),
    allow: async (publicKey) => (await env.INGEST_RL.limit({ key: publicKey })).success,
    spill: (projectId, eventId, payload) => spill.put(projectId, eventId, payload),
    send: async (message) => {
      await env.EVENTS_Q.send(message);
    },
    now: () => Date.now(),
  };
}

function consumerDeps(env: Env): ConsumerDeps {
  const store = new BatchStore(env.DB);
  const blobs = new EventBlobs(env.BLOBS);
  const spill = new SpillStore(env.BLOBS);

  return {
    readState: (keys) => store.readState(keys),
    readStored: (keys) => store.readStored(keys),
    commit: (writes, now) => store.commit(writes, now),
    putBlobs: (events) => blobs.putAll(events),
    loadSpill: (key) => spill.get(key),
    deleteSpill: (keys) => spill.deleteAll(keys),
    maxStoredPerGroupHour: Number(env.MAX_STORED_PER_GROUP_HOUR),
    now: () => Date.now(),
  };
}

function apiDeps(env: Env): ApiDeps {
  accessVerifier ??= new AccessVerifier(
    { teamDomain: env.ACCESS_TEAM_DOMAIN, audience: env.ACCESS_AUD, devEmail: env.DEV_USER_EMAIL },
    fetchAccessKeys,
  );

  return {
    access: accessVerifier,
    tenancy: new TenancyStore(env.DB),
    projects: new ProjectStore(env.DB),
    issues: new IssueStore(env.DB),
    events: new EventStore(env.DB),
    blobs: new EventBlobs(env.BLOBS),
    ingestHost: env.INGEST_HOST,
    now: () => Date.now(),
  };
}

function retentionDeps(env: Env): RetentionDeps {
  const store = new RetentionStore(env.DB);

  return {
    deleteEventsBefore: (cutoff) => store.deleteEventsBefore(cutoff),
    deleteStatsBefore: (cutoffs) => store.deleteStatsBefore(cutoffs),
    pruneTags: (keep) => store.pruneTags(keep),
    clearExpiredLimits: (now) => store.clearExpiredLimits(now),
    retentionDays: Number(env.RETENTION_DAYS),
    now: () => Date.now(),
  };
}

function spikeDeps(env: Env): SpikeDeps {
  const store = new SpikeStore(env.DB);

  return {
    read: (since, before) => store.read(since, before),
    write: (limits) => store.write(limits),
    maxEventsPerMonth: positiveInt(env.MAX_EVENTS_PER_MONTH, "MAX_EVENTS_PER_MONTH"),
    now: () => Date.now(),
  };
}

const RETENTION_CRON = "17 3 * * *";
const SPIKE_CRON = "3 * * * *";

async function runCron(cron: string, env: Env): Promise<void> {
  if (cron === RETENTION_CRON) {
    await runRetention(retentionDeps(env));

    return;
  }

  if (cron === SPIKE_CRON) {
    await runSpikeProtection(spikeDeps(env));

    return;
  }

  // A cron added to wrangler.jsonc without a handler here is a bug to see, not to skip.
  throw new Error(`no handler for cron "${cron}"`);
}

async function serveApi(request: Request, env: Env): Promise<Response> {
  try {
    return await handleApi(request, apiDeps(env), sessions);
  } catch (cause) {
    logError("api request failed", { url: request.url, error: errorText(cause) });

    return Response.json({ detail: "internal error" }, { status: 500 });
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const ingestRoute = matchIngestRoute(url);

    if (ingestRoute !== null) {
      return handleIngest(request, ingestRoute, ingestDeps(env));
    }

    // The ingest hostname is public, so it serves nothing but the ingest routes.
    if (url.hostname === env.INGEST_HOST) {
      return new Response("not found", { status: 404 });
    }

    return url.pathname.startsWith("/api/") ? serveApi(request, env) : env.ASSETS.fetch(request);
  },

  async queue(batch, env): Promise<void> {
    await handleBatch(batch, consumerDeps(env));
  },

  async scheduled(controller, env): Promise<void> {
    await runCron(controller.cron, env);
  },
} satisfies ExportedHandler<Env, QueueMessage>;
