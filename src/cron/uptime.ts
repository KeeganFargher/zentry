import { z } from "zod";

import type { ProbeResult, UptimeMonitorStore } from "@/db/uptime-monitors";
import type { UptimeSettings, UptimeJob } from "@/shared/monitors";
import { MINUTE } from "@/shared/time";
import type { NotifyMessage, QueueMessage } from "@/shared/types";

const Job = z.object({ id: z.uuid(), token: z.uuid() });

const ProbeResponse = z.object({
  outcome: z.enum(["ok", "failed", "unknown"]),
  httpStatus: z.int().optional(),
  durationMs: z.int().nonnegative().optional(),
});

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
  store: UptimeMonitorStore,
  binding: Fetcher,
): Promise<void> {
  await Promise.all(
    batch.messages.map(async (message) => {
      const job = Job.parse(message.body);
      const config = await store.start(job, Date.now());

      try {
        if (config !== null) {
          await store.finish(job, await requestProbe(binding, config));
        }

        message.ack();
      } catch (cause) {
        await store.retry(job);
        throw cause;
      }
    }),
  );
}

export async function requestProbe(binding: Fetcher, config: UptimeSettings): Promise<ProbeResult> {
  const { url, method, timeoutMs } = config;

  const response = await binding.fetch("https://uptime-probe.internal/", {
    method: "POST",
    body: JSON.stringify({ url, method, timeoutMs }),
  });

  if (!response.ok) {
    throw new Error("uptime probe service did not return a result");
  }

  return ProbeResponse.parse(await response.json());
}
