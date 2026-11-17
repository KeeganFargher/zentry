// The event's exceptions, with the stack attached from wherever the SDK put it.

import type { StoredException, StoredFrame, StoredMechanism } from "@/shared/contract";

import { toStoredFrames } from "./frames";
import { scrubText } from "./scrub";
import type { WireEvent, WireException, WireMechanism, WireThread } from "./wire";

const MAX_EXCEPTIONS = 20;

function toStoredMechanism(raw: WireMechanism): StoredMechanism {
  return {
    type: raw.type,
    handled: raw.handled,
    synthetic: raw.synthetic,
    exceptionGroup: raw.is_exception_group,
  };
}

function toStoredException(raw: WireException): StoredException {
  return {
    type: raw.type,
    value: raw.value === null ? null : scrubText(raw.value),
    module: raw.module,
    mechanism: raw.mechanism === null ? null : toStoredMechanism(raw.mechanism),
    frames: raw.stacktrace === null ? [] : toStoredFrames(raw.stacktrace),
  };
}

function framesOf(thread: WireThread): StoredFrame[] {
  return thread.stacktrace === null ? [] : toStoredFrames(thread.stacktrace);
}

/** The stack of the thread that crashed, else the current one, else the first with frames. */
function threadFrames(threads: WireThread[]): StoredFrame[] {
  const withStacks = threads.flatMap((thread) => {
    const frames = framesOf(thread);

    return frames.length === 0 ? [] : [{ thread, frames }];
  });

  const chosen =
    withStacks.find(({ thread }) => thread.crashed) ??
    withStacks.find(({ thread }) => thread.current) ??
    withStacks[0];

  return chosen?.frames ?? [];
}

/**
 * The event's exceptions, in SDK order: root cause first, the one raised last.
 * Some SDKs keep the stack outside `exception`, in `threads` or a top-level
 * `stacktrace`. When no exception has frames of its own, that stack goes on
 * the last exception, or on a bare one with no type or value when the event
 * has none, so the trace shows and the event still groups by where it happened.
 */
export function toStoredExceptions(raw: WireEvent): StoredException[] {
  const exceptions = raw.exception.slice(-MAX_EXCEPTIONS).map(toStoredException);

  if (exceptions.some((exception) => exception.frames.length > 0)) {
    return exceptions;
  }

  const topLevel = raw.stacktrace === null ? [] : toStoredFrames(raw.stacktrace);
  const frames = topLevel.length > 0 ? topLevel : threadFrames(raw.threads);
  const last = exceptions.at(-1);

  if (frames.length === 0) {
    return exceptions;
  }

  const stacked: StoredException = last ?? {
    type: null,
    value: null,
    module: null,
    mechanism: null,
    frames: [],
  };

  return [...exceptions.slice(0, -1), { ...stacked, frames }];
}
