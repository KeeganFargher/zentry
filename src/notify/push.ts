// Sends one push to every phone of the given users, at most once per phone.
// DESIGN.md §19. Like the mailer: each push is claimed in push_sends before it
// goes, so a queue redelivery skips what already went out.

import type { PushTarget } from "@/db/devices";
import { logError } from "@/shared/log";
import { pushError, SEND_BATCH } from "@/shared/push";
import type { PushContent, PushTicket } from "@/shared/push";

import type { NotifyDeps } from "./deps";
import { SendDeferred } from "./providers";

/** One push to fan out. `key` is unique to what it is about, as an email's is. */
export type PushJob = { key: string; content: PushContent };

type Claimed = { target: PushTarget; key: string };

async function claimAll(deps: NotifyDeps, targets: PushTarget[], job: PushJob): Promise<Claimed[]> {
  const now = deps.now();
  const claimed: Claimed[] = [];

  for (const target of targets) {
    const key = `${job.key}:${target.userId}:${target.deviceId}`;

    if ((await deps.pushes.claim(key, target, now)) === "new") {
      claimed.push({ target, key });
    }
  }

  return claimed;
}

/**
 * Settles one push by its ticket. An install Expo no longer knows (the app was
 * uninstalled, or its token rotated) loses its token, so it is not tried again.
 */
async function settleTicket(deps: NotifyDeps, sent: Claimed, ticket: PushTicket): Promise<void> {
  if (ticket.status === "ok") {
    await deps.pushes.settle(sent.key, { status: "sent", ticketId: ticket.id });

    return;
  }

  if (ticket.error === "DeviceNotRegistered") {
    await deps.devices.forgetPushToken(sent.target.pushToken);
  } else {
    logError("push not sent", { key: sent.key, error: ticket.error, message: ticket.message });
  }

  await deps.pushes.settle(sent.key, {
    status: "failed",
    error: pushError(ticket),
  });
}

async function sendChunk(deps: NotifyDeps, chunk: Claimed[], content: PushContent): Promise<void> {
  const result = await deps.sendPush(
    chunk.map(({ target }) => ({
      to: target.pushToken,
      title: content.title,
      body: content.body,
      data: content.data,
      channelId: content.channel,
    })),
  );

  if (!result.ok && result.retryable) {
    // Expo asked to wait, or could not be reached: stop the drain without
    // counting an attempt against the row, exactly as a deferred email does.
    throw new SendDeferred("push", result.error);
  }

  if (!result.ok && chunk.length > 1) {
    // Expo refuses a whole request for one bad message, such as a token from
    // another Expo project (a dev build) mixed in. Sending each alone keeps
    // that one phone from failing everyone else's push.
    for (const sent of chunk) {
      await sendChunk(deps, [sent], content);
    }

    return;
  }

  if (!result.ok) {
    logError("push refused", { keys: chunk.map((sent) => sent.key), error: result.error });

    for (const sent of chunk) {
      await deps.pushes.settle(sent.key, { status: "failed", error: result.error });
    }

    return;
  }

  for (const [index, sent] of chunk.entries()) {
    const ticket = result.value[index];

    if (ticket === undefined) {
      throw new Error(`Expo returned no ticket for push ${index}`);
    }

    await settleTicket(deps, sent, ticket);
  }
}

export async function pushTo(deps: NotifyDeps, userIds: number[], job: PushJob): Promise<void> {
  const claimed = await claimAll(deps, await deps.devices.pushTargets(userIds), job);

  for (let start = 0; start < claimed.length; start += SEND_BATCH) {
    await sendChunk(deps, claimed.slice(start, start + SEND_BATCH), job.content);
  }
}
