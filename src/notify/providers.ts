// Email and push go out independently. DESIGN.md §19.2: one provider being
// told to wait (Cloudflare's daily email cap, a sender not yet onboarded, an
// Expo outage) must not hold back the other.
//
// A provider that defers is paused for the rest of the drain: its later rows
// are left for the retry without calling it again, while the other provider
// carries on. Both are idempotent (email_sends, push_sends), so the retry
// sends only what did not go out.

import type { NotificationProvider } from "@/shared/contract";

import type { NotifyDeps } from "./deps";

/**
 * Thrown when a provider asks to try later, or is paused. The drain leaves
 * the row as it is, without counting an attempt against it: a busy hour must
 * not use up its attempts.
 */
export class SendDeferred extends Error {
  readonly provider: NotificationProvider;

  constructor(provider: NotificationProvider, reason: string) {
    super(`${provider}: ${reason}`);
    this.provider = provider;
  }
}

export type ProviderSend = [provider: NotificationProvider, send: () => Promise<void>];

async function attempt(deps: NotifyDeps, [provider, send]: ProviderSend): Promise<void> {
  if (deps.paused.has(provider)) {
    throw new SendDeferred(provider, "paused for this drain");
  }

  try {
    await send();
  } catch (cause) {
    if (cause instanceof SendDeferred) {
      deps.paused.add(cause.provider);
    }

    throw cause;
  }
}

/**
 * Runs every provider's send, even when an earlier one fails, then throws: a
 * real failure first (it counts an attempt), else a deferral (it does not).
 */
export async function eachProvider(deps: NotifyDeps, sends: ProviderSend[]): Promise<void> {
  const errors: unknown[] = [];

  for (const send of sends) {
    try {
      await attempt(deps, send);
    } catch (cause) {
      errors.push(cause);
    }
  }

  const failure = errors.find((cause) => !(cause instanceof SendDeferred)) ?? errors[0];

  if (failure !== undefined) {
    throw failure;
  }
}
