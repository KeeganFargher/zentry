// Stack frames: the frame limit, scrubbing of vars, and the default in-app rule.

import type { StoredFrame } from "@/shared/contract";

import { looksLikeLibrary } from "./inapp";
import { scrubObject } from "./scrub";
import { trimObject } from "./trim";
import type { WireFrame, WireStacktrace } from "./wire";

const MAX_FRAMES = 250;
const MAX_CONTEXT_LINES = 10;
const VARS_LIMITS = { depth: 3, maxKeys: 50, maxString: 512 };

/** Keeps the lines nearest the error: the last of `pre_context`, the first of `post_context`. */
function nearestLines(lines: string[], side: "pre" | "post"): string[] {
  return side === "pre" ? lines.slice(-MAX_CONTEXT_LINES) : lines.slice(0, MAX_CONTEXT_LINES);
}

function toStoredFrame(raw: WireFrame): StoredFrame {
  const located = {
    filename: raw.filename,
    absPath: raw.abs_path,
    module: raw.module,
    function: raw.function,
  };

  return {
    ...located,
    lineno: raw.lineno,
    colno: raw.colno,
    inApp: raw.in_app ?? !looksLikeLibrary(located),
    contextLine: raw.context_line,
    preContext: nearestLines(raw.pre_context, "pre"),
    postContext: nearestLines(raw.post_context, "post"),
    vars: raw.vars === null ? null : scrubObject(trimObject(raw.vars, VARS_LIMITS)),
  };
}

/** Frames are kept in SDK order: oldest call first, crash site last. */
export function toStoredFrames(stacktrace: WireStacktrace): StoredFrame[] {
  const { frames } = stacktrace;
  const half = MAX_FRAMES / 2;

  const kept =
    frames.length > MAX_FRAMES ? [...frames.slice(0, half), ...frames.slice(-half)] : frames;

  return kept.map(toStoredFrame);
}
