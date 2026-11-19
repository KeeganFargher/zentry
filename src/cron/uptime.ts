import { z } from "zod";

import type { MonitorPreviews } from "@/db/monitor-previews";
import type { ProbeRequest, ProbeResult, UptimeMonitorStore } from "@/db/uptime-monitors";
import type { UptimeJob } from "@/shared/monitors";
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
  await Promise.all(
    batch.messages.map(async (message) => {
      const job = Job.parse(message.body);

      if ("previewId" in job) {
        await runPreview(previews, binding, job.previewId);
        message.ack();

        return;
      }

      const config = await store.start(job, Date.now());

      // Once an attempt is claimed, retrying the message must not repeat the
      // target request. If persistence fails, the expired lease records a gap.
      if (config !== null) {
        await store.finish(job, await requestProbe(binding, config), Date.now());
      }

      message.ack();
    }),
  );
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

  const result = await requestProbe(binding, configuration).catch((): ProbeResult => ({
    outcome: "unknown",
    reason: "network",
  }));

  await store.finish(id, result, Date.now());
}

async function requestProbe(
  binding: Pick<Fetcher, "fetch">,
  input: ProbeRequest,
): Promise<ProbeResult> {
  const { url, method, timeoutMs, successCodes } = input.config;

  const response = await binding.fetch("https://uptime-probe.internal/", {
    method: "POST",
    body: JSON.stringify({
      url,
      method,
      timeoutMs,
      successCodes,
      organizationId: input.organizationId,
    }),
  });

  if (!response.ok) {
    throw new Error("uptime probe service did not return a result");
  }

  return ProbeResponse.parse(await response.json());
}
