// Source context from uploaded source bundles: the lines around each of the
// app's own frames, for SDKs that cannot send them (the .NET SDK reads only
// file and line from the PDB at runtime). Sentry does this in Symbolicator,
// before grouping; Zentry does it in the consumer at the same point, so an
// event is stored with its source and every reader (UI, app, Markdown, email)
// shows it without asking for anything else.
//
// A frame qualifies when it is in-app, has a line, a build path and the debug
// id of its image, and the SDK sent no context of its own. The bundle is the
// one uploaded for that debug id, so the lines are those of the exact build
// that ran, not of whatever the branch holds today.

import type { StoredEvent, StoredException, StoredFrame } from "@/shared/contract";

import { MAX_LINE, cut } from "./trim";

/** Sentry's window (symbolicator's `SOURCE_CONTEXT_LINES`): five lines either side. */
const CONTEXT_LINES = 5;

/** Build paths each debug id is asked for. */
export type SourceRequest = Map<string, Set<string>>;

/** The source text of a build path in a debug id's bundle; null when it has none. */
export type SourceLookup = (debugId: string, path: string) => string | null;

type Wanted = StoredFrame & { debugId: string; absPath: string; lineno: number };

function wants(frame: StoredFrame): frame is Wanted {
  return (
    frame.inApp &&
    frame.contextLine === null &&
    frame.lineno !== null &&
    frame.absPath !== null &&
    frame.debugId !== null &&
    frame.debugId !== undefined
  );
}

function framesOf(event: StoredEvent): StoredFrame[] {
  return event.exceptions.flatMap((exception) => exception.frames);
}

/** What the event needs from source bundles, by debug id. */
export function sourceRequest(event: StoredEvent): SourceRequest {
  const request: SourceRequest = new Map();

  for (const frame of framesOf(event).filter(wants)) {
    const paths = request.get(frame.debugId) ?? new Set<string>();

    paths.add(frame.absPath);
    request.set(frame.debugId, paths);
  }

  return request;
}

function withLines(frame: Wanted, text: string): StoredFrame {
  const lines = text.split(/\r?\n/).map((line) => cut(line, MAX_LINE));
  const index = frame.lineno - 1;
  const contextLine = lines[index];

  // A line past the end means the bundle is not the source this build ran
  // from; showing some other line would mislead, so the frame keeps none.
  if (index < 0 || contextLine === undefined) {
    return frame;
  }

  return {
    ...frame,
    contextLine,
    preContext: lines.slice(Math.max(0, index - CONTEXT_LINES), index),
    postContext: lines.slice(index + 1, index + 1 + CONTEXT_LINES),
  };
}

function frameWithSource(frame: StoredFrame, lookup: SourceLookup): StoredFrame {
  if (!wants(frame)) {
    return frame;
  }

  const text = lookup(frame.debugId, frame.absPath);

  return text === null ? frame : withLines(frame, text);
}

/** The event with source context on every frame its bundles cover. */
export function withSourceContext(event: StoredEvent, lookup: SourceLookup): StoredEvent {
  const exceptions = event.exceptions.map((exception): StoredException => ({
    ...exception,
    frames: exception.frames.map((frame) => frameWithSource(frame, lookup)),
  }));

  return { ...event, exceptions };
}
