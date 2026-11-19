import { z } from "zod";

import { planIssues } from "@/core/monitor-issues";
import { uptimeResult, uptimeSignal } from "@/core/uptime-results";
import type { MonitorPreviews } from "@/db/monitor-previews";
import type { ProbeResult, UptimeMonitorStore } from "@/db/uptime-monitors";
import { errorText, logError } from "@/shared/log";
import type { ScheduledUptimeJob, UptimeJob, UptimeSettings } from "@/shared/monitors";
import { MINUTE } from "@/shared/time";
import type { NotifyMessage, QueueMessage } from "@/shared/types";
import { ProbeResponse } from "@/shared/uptime";

const Job = z.union([
  z.strictObject({ id: z.uuid(), token: z.uuid() }),
  z.strictObject({ previewId: z.uuid() }),
]);

export async function dispatchUptime(
  store: UptimeMonitorStore,
  scheduledTime: number,
  queue: Queue<UptimeJob>,
): Promise<void> {
  const claim = {
    slot: Math.floor(scheduledTime / MINUTE) * MINUTE,
    token: crypto.randomUUID(),
    now: Date.now(),
  };

  const checks = await store.claim(claim);

  if (checks.length === 0) {
    return;
  }

  await queue.sendBatch(checks.map(({ id }) => ({ body: { id, token: claim.token } })));
}

export async function handleUptimeBatch(
  batch: MessageBatch<QueueMessage | NotifyMessage | UptimeJob>,
  {
    store,
    previews,
    binding,
  }: { store: UptimeMonitorStore; previews: MonitorPreviews; binding: Pick<Fetcher, "fetch"> },
): Promise<void> {
  // Settled one by one, so one failing message does not retry its batch.
  // A failure before the probe is claimed is retried; after the claim,
  // runJob acknowledges it instead, because a retry cannot probe again.
  await Promise.allSettled(
    batch.messages.map(async (message) => {
      try {
        await runJob(Job.parse(message.body), { store, previews, binding });
        message.ack();
      } catch (cause) {
        logError("uptime job failed before its probe; retrying", { error: errorText(cause) });
        message.retry();
      }
    }),
  );
}

async function runJob(
  job: z.output<typeof Job>,
  deps: { store: UptimeMonitorStore; previews: MonitorPreviews; binding: Pick<Fetcher, "fetch"> },
): Promise<void> {
  if ("previewId" in job) {
    await runPreview(deps.previews, deps.binding, job.previewId);

    return;
  }

  const config = await deps.store.start(job, Date.now());

  if (config === null) {
    return;
  }

  // Once an attempt is claimed, retrying the message must not repeat the
  // target request. If saving the result fails, the expired lease records the
  // slot as a coverage gap on the next tick.
  try {
    await saveCheck(deps.store, job, await probeOrUnknown(deps.binding, config));
  } catch (cause) {
    logError("uptime result was not saved; the slot will be a gap", { error: errorText(cause) });
  }
}

/** Decides the check against the monitor as it is now, then saves it if the lease is still this job's. */
async function saveCheck(
  store: UptimeMonitorStore,
  job: ScheduledUptimeJob,
  result: ProbeResult,
): Promise<void> {
  const finishing = await store.finishing(job, Date.now());

  if (finishing === null) {
    return;
  }

  const next = uptimeResult(finishing.streaks, result.outcome);
  const plan = planIssues(finishing.issue, [uptimeSignal(next, result.outcome, finishing.slot)]);

  await store.finish(
    job,
    { result, next, plan, scope: finishing.scope, slot: finishing.slot },
    Date.now(),
  );
}

/**
 * The probe Worker failing is Zentry's failure, not the target's, so it is an
 * unknown result: it resets the streak without counting as downtime.
 */
async function probeOrUnknown(
  binding: Pick<Fetcher, "fetch">,
  config: UptimeSettings,
): Promise<ProbeResult> {
  try {
    return await requestProbe(binding, config);
  } catch (cause) {
    logError("uptime probe service failed", { error: errorText(cause) });

    return { outcome: "unknown", reason: "probe_unavailable" };
  }
}

async function runPreview(
  store: MonitorPreviews,
  binding: Pick<Fetcher, "fetch">,
  id: string,
): Promise<void> {
  const configuration = await store.start(id, Date.now());

  if (configuration === null) {
    return;
  }

  await store.finish(id, await probeOrUnknown(binding, configuration), Date.now());
}

async function requestProbe(
  binding: Pick<Fetcher, "fetch">,
  config: UptimeSettings,
): Promise<ProbeResult> {
  const { url, method, timeoutMs, successCodes } = config;

  const response = await binding.fetch("https://uptime-probe.internal/", {
    method: "POST",
    body: JSON.stringify({
      url,
      method,
      timeoutMs,
      successCodes,
    }),
  });

  if (!response.ok) {
    throw new Error("uptime probe service did not return a result");
  }

  return ProbeResponse.parse(await response.json());
}
