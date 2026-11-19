// Composition root: the only file that touches bindings. It builds the
// stores and hands typed functions to the four handlers.

import { AccessVerifier, fetchAccessKeys } from "@/api/access";
import type { ApiDeps } from "@/api/context";
import { serveApi, Sessions, serveAppApi } from "@/api/router";
import { EventBlobs } from "@/blobs/events";
import { SpillStore } from "@/blobs/spill";
import { handleBatch } from "@/consumer/handler";
import type { ConsumerDeps } from "@/consumer/handler";
import { evaluateMonitors } from "@/cron/monitors";
import { runWeeklyReports, sweepOutbox } from "@/cron/notify";
import type { NotifyCronDeps } from "@/cron/notify";
import { checkPushReceipts } from "@/cron/push-receipts";
import type { PushReceiptDeps } from "@/cron/push-receipts";
import { runRetention } from "@/cron/retention";
import type { RetentionDeps } from "@/cron/retention";
import { runSpikeProtection } from "@/cron/spike";
import type { SpikeDeps } from "@/cron/spike";
import { handleUptimeBatch } from "@/cron/uptime";
import { BatchStore } from "@/db/batch";
import { CronStore } from "@/db/cron-store";
import { DeviceStore } from "@/db/devices";
import { EventStore } from "@/db/events";
import { IssueStore } from "@/db/issues";
import { KeyStore } from "@/db/keys";
import { MailStore } from "@/db/mail";
import { enqueueMetricInput, MetricCapture } from "@/db/metric-input";
import { MonitorPreviews } from "@/db/monitor-previews";
import { MonitorRuleStore } from "@/db/monitor-rules";
import { MonitorStore } from "@/db/monitors";
import { NotifyStore } from "@/db/notify";
import { NotificationSettingsStore } from "@/db/notify-settings";
import { OrganizationStore } from "@/db/organizations";
import { ProjectStore } from "@/db/projects";
import { PushSendStore } from "@/db/pushes";
import { ReportStore } from "@/db/reports";
import { RetentionStore } from "@/db/retention";
import { SpikeStore } from "@/db/spike";
import { TenancyStore } from "@/db/tenancy";
import { UptimeMonitorStore } from "@/db/uptime-monitors";
import { UsageStore } from "@/db/usage";
import { KeyCache } from "@/ingest/auth";
import { receiveCheckIn } from "@/ingest/cron-receive";
import { handleIngest, matchIngestRoute } from "@/ingest/handler";
import type { IngestDeps } from "@/ingest/handler";
import { rejected } from "@/ingest/http";
import { UsageCache } from "@/ingest/limits";
import type { MailConfig, NotifyDeps } from "@/notify/deps";
import { handleNotifyBatch } from "@/notify/handler";
import { handleUnsubscribe, UNSUBSCRIBE_PATH } from "@/notify/unsubscribe";
import { ExpoPush } from "@/push/expo";
import { logError } from "@/shared/log";
import type { UptimeJob } from "@/shared/monitors";
import type { NotifyMessage, QueueMessage } from "@/shared/types";

// Per-isolate caches, shared by every request the isolate serves.
let keyCache: KeyCache | undefined;
let usageCache: UsageCache | undefined;
let metricCapture: MetricCapture | undefined;
let accessVerifier: AccessVerifier | undefined;
const sessions = new Sessions();

// Wrapped, because the Workers runtime refuses a `fetch` called detached from the global.
const expo = new ExpoPush((input, init) => fetch(input, init));

function ingestDeps(env: Env): IngestDeps {
  // The caches outlive this request, so their lookups open their own stores.
  keyCache ??= new KeyCache((publicKey) => new KeyStore(env.DB).findActive(publicKey));
  usageCache ??= new UsageCache((organization, month) =>
    new UsageStore(env.DB).received(organization, month),
  );

  const capture = (metricCapture ??= new MetricCapture(env.DB));

  return {
    allowCheckIn: async (key) => (await env.CHECK_IN_RL.limit({ key })).success,
    recordCheckIn: (projectId, checkIn, now) =>
      receiveCheckIn(new CronStore(env.DB), { projectId, checkIn, now }),
    keys: keyCache,
    usage: usageCache,
    allow: async (publicKey) => (await env.INGEST_RL.limit({ key: publicKey })).success,
    spill: (projectId, eventId, payload) =>
      new SpillStore(env.BLOBS).put(projectId, eventId, payload),
    send: (message) =>
      enqueueMetricInput({ db: env.DB, queue: env.EVENTS_Q, capture, now: Date.now() }, message),
    now: () => Date.now(),
  };
}

/** Wakes the notify consumer to drain the outbox. */
async function wakeNotify(env: Env): Promise<void> {
  await env.NOTIFY_Q.send({ kind: "drain" } satisfies NotifyMessage);
}

/**
 * A required secret that was never set arrives as undefined at runtime,
 * whatever the generated type says; treat it as empty.
 */
function signingKey(env: Env): string {
  const secrets: Partial<Pick<Env, "EMAIL_SIGNING_KEY">> = env;

  return secrets.EMAIL_SIGNING_KEY ?? "";
}

/** Asks for a flush of the project's digest window after `delaySeconds`. */
async function flushLater(env: Env, projectId: number, delaySeconds: number): Promise<void> {
  await env.NOTIFY_Q.send({ kind: "digest", project_id: projectId } satisfies NotifyMessage, {
    delaySeconds,
  });
}

/**
 * Null while EMAIL_FROM is empty: notifications are then drained unsent. A
 * sender without a signing key is a configuration mistake, so it is logged
 * and treated the same, rather than sending emails with no unsubscribe link.
 */
function mailConfig(env: Env): MailConfig | null {
  if (env.EMAIL_FROM === "") {
    return null;
  }

  if (signingKey(env) === "") {
    logError("EMAIL_FROM is set but EMAIL_SIGNING_KEY is not; sending no email");

    return null;
  }

  return {
    from: env.EMAIL_FROM,
    appUrl: env.APP_URL.replace(/\/+$/, ""),
    unsubscribeUrl: `https://${env.INGEST_HOST}${UNSUBSCRIBE_PATH}`,
    signingKey: signingKey(env),
  };
}

function notifyDeps(env: Env): NotifyDeps {
  return {
    store: new NotifyStore(env.DB),
    monitorAlertsPaused: env.MONITOR_ALERTS_PAUSED !== "0",
    monitorBelowCountPaging: env.MONITOR_BELOW_COUNT_PAGING === "1",
    settings: new NotificationSettingsStore(env.DB),
    mail: new MailStore(env.DB),
    reports: new ReportStore(env.DB),
    send: (message) => env.EMAIL.send(message),
    devices: new DeviceStore(env.DB),
    pushes: new PushSendStore(env.DB),
    sendPush: (messages) => expo.send(messages),
    paused: new Set(),
    latestEvent: async (issue) =>
      issue.lastEventId === null
        ? null
        : new EventBlobs(env.BLOBS).summary(issue.project.id, issue.lastEventId),
    scheduleDigest: (projectId, delaySeconds) => flushLater(env, projectId, delaySeconds),
    drainAgain: () => wakeNotify(env),
    config: mailConfig(env),
    now: () => Date.now(),
  };
}

function notifyCronDeps(env: Env): NotifyCronDeps {
  const store = new NotifyStore(env.DB);

  return {
    queueWeeklyReports: (range, now) => store.queueWeeklyReports(range, now),
    outboxSize: () => store.outboxSize(),
    overdueDigests: (now, grace) => store.overdueDigests(now, grace),
    scheduleDigest: (projectId) => flushLater(env, projectId, 0),
    notify: () => wakeNotify(env),
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
    commit: (writes, now, inputs) => store.commit(writes, now, inputs),
    release: (inputs) => store.release(inputs),
    putBlobs: (events) => blobs.putAll(events),
    loadSpill: (key) => spill.get(key),
    deleteSpill: (keys) => spill.deleteAll(keys),
    notify: () => wakeNotify(env),
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
    organizations: new OrganizationStore(env.DB),
    projects: new ProjectStore(env.DB),
    monitors: new MonitorStore(env.DB),
    monitorRules: new MonitorRuleStore(env.DB),
    issues: new IssueStore(env.DB),
    events: new EventStore(env.DB),
    blobs: new EventBlobs(env.BLOBS),
    notificationSettings: new NotificationSettingsStore(env.DB),
    devices: new DeviceStore(env.DB),
    notify: () => wakeNotify(env),
    emailEnabled: mailConfig(env) !== null,
    uptimeOrigins: env.UPTIME_ORIGINS,
    uptimeFixtureOrigin: env.UPTIME_FIXTURE_ORIGIN,
    allowMonitorPreview: async (key) => (await env.MONITOR_PREVIEW_RL.limit({ key })).success,
    monitorPreviews: new MonitorPreviews(env.DB),
    enqueueMonitorPreview: (previewId) => env.UPTIME_Q.send({ previewId }).then(() => undefined),
    ingestHost: env.INGEST_HOST,
    mobileApiUrl: env.MOBILE_API_URL.replace(/\/+$/, ""),
    now: () => Date.now(),
  };
}

function retentionDeps(env: Env): RetentionDeps {
  const store = new RetentionStore(env.DB);

  return {
    deleteEventsBefore: (cutoff) => store.deleteEventsBefore(cutoff),
    deleteGroupStatsBefore: (cutoff) => store.deleteGroupStatsBefore(cutoff),
    deleteProjectStatsBefore: (cutoff) => store.deleteProjectStatsBefore(cutoff),
    pruneTags: (keep) => store.pruneTags(keep),
    clearExpiredLimits: (now) => store.clearExpiredLimits(now),
    deleteEmailSendsBefore: (cutoff) => store.deleteEmailSendsBefore(cutoff),
    deletePushSendsBefore: (cutoff) => store.deletePushSendsBefore(cutoff),
    retentionDays: Number(env.RETENTION_DAYS),
    now: () => Date.now(),
  };
}

function pushReceiptDeps(env: Env): PushReceiptDeps {
  const pushes = new PushSendStore(env.DB);
  const devices = new DeviceStore(env.DB);

  return {
    awaiting: (window, cursor, limit) => pushes.awaitingReceipts(window, cursor, limit),
    receipts: (ids) => expo.receipts(ids),
    settle: (key, outcome) => pushes.settle(key, outcome),
    expire: (before) => pushes.expireReceipts(before),
    forgetPushToken: (pushToken) => devices.forgetPushToken(pushToken),
    now: () => Date.now(),
  };
}

function spikeDeps(env: Env): SpikeDeps {
  const store = new SpikeStore(env.DB);

  return {
    read: (since, before) => store.read(since, before),
    write: (limits) => store.write(limits),
    now: () => Date.now(),
  };
}

const RETENTION_CRON = "17 3 * * *";
const SPIKE_CRON = "3 * * * *";
const WEEKLY_REPORT_CRON = "0 12 * * 6";

async function runCron(cron: string, env: Env): Promise<void> {
  if (cron === RETENTION_CRON) {
    return runRetention(retentionDeps(env));
  }

  if (cron === SPIKE_CRON) {
    // Independent jobs: one failing must not skip the others. Each still
    // throws, so a failure shows in the logs.
    const jobs = await Promise.allSettled([
      runSpikeProtection(spikeDeps(env)),
      sweepOutbox(notifyCronDeps(env)),
      checkPushReceipts(pushReceiptDeps(env)),
    ]);

    const failed = jobs.flatMap((job) => (job.status === "rejected" ? [job.reason] : []));

    if (failed.length > 0) {
      throw new AggregateError(failed, `${failed.length} hourly jobs failed`);
    }

    return;
  }

  if (cron === WEEKLY_REPORT_CRON) {
    return runWeeklyReports(notifyCronDeps(env));
  }

  // A cron added to wrangler.jsonc without a handler here is a bug to see, not to skip.
  throw new Error(`no handler for cron "${cron}"`);
}

type AnyBatch = MessageBatch<QueueMessage | NotifyMessage | UptimeJob>;

// Each queue carries one kind of message, sent only by this Worker.
function isEventBatch(batch: AnyBatch): batch is MessageBatch<QueueMessage> {
  return batch.queue === "zentry-events";
}

function isNotifyBatch(batch: AnyBatch): batch is MessageBatch<NotifyMessage> {
  return batch.queue === "zentry-notify";
}

/**
 * The API on the public ingest host, limited per client address: Access does
 * not guard it, and every request costs a D1 read (DESIGN.md §19.1).
 */
export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    // On every host, the ingest one included: mail providers POST here without
    // signing in to Access (DESIGN.md §18.6).
    if (url.pathname === UNSUBSCRIBE_PATH) {
      return handleUnsubscribe(request, {
        store: new NotifyStore(env.DB),
        settings: new NotificationSettingsStore(env.DB),
        signingKey: signingKey(env),
        now: () => Date.now(),
      });
    }

    const ingestRoute = matchIngestRoute(url);

    if (ingestRoute !== null) {
      return handleIngest(request, ingestRoute, ingestDeps(env));
    }

    // The ingest hostname is public, so besides ingest it serves only the API
    // for the mobile app, where the router accepts device tokens alone
    // (DESIGN.md §19). Access guards the UI hostname at the edge, so a phone
    // could not reach the API there.
    if (url.hostname === env.INGEST_HOST) {
      return url.pathname.startsWith("/api/0/")
        ? serveAppApi(request, env.APP_API_RL, () => serveApi(request, apiDeps(env), sessions))
        : rejected(404, "not found");
    }

    return url.pathname.startsWith("/api/")
      ? serveApi(request, apiDeps(env), sessions)
      : env.ASSETS.fetch(request);
  },

  async queue(batch, env): Promise<void> {
    if (isEventBatch(batch)) {
      await handleBatch(batch, consumerDeps(env));
    } else if (batch.queue === "zentry-uptime") {
      await handleUptimeBatch(batch, {
        store: new UptimeMonitorStore(env.DB),
        previews: new MonitorPreviews(env.DB),
        binding: env.UPTIME_PROBE,
      });
    } else if (isNotifyBatch(batch)) {
      await handleNotifyBatch(batch, notifyDeps(env));
    } else {
      throw new Error(`no consumer for queue "${batch.queue}"`);
    }
  },

  async scheduled(controller, env): Promise<void> {
    if (controller.cron === "* * * * *") {
      return evaluateMonitors(controller.scheduledTime, {
        db: env.DB,
        queue: env.UPTIME_Q,
        notify: notifyCronDeps(env),
      });
    }

    await runCron(controller.cron, env);
  },
} satisfies ExportedHandler<Env, QueueMessage | NotifyMessage | UptimeJob>;
