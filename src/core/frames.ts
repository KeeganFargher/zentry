// Stack frames: the frame limit, scrubbing of vars, and the default in-app rule.

import type { StoredFrame } from "@/shared/contract";

import { looksLikeLibrary } from "./inapp";
import { scrubObject } from "./scrub";
import { trimObject } from "./trim";
import type { WireDebugImage, WireFrame, WireStacktrace } from "./wire";

/** The event's `debug_meta.images`, by position; null where an image was invalid. */
export type DebugImages = (WireDebugImage | null)[];

const MAX_FRAMES = 250;
const MAX_CONTEXT_LINES = 10;
const VARS_LIMITS = { depth: 3, maxKeys: 50, maxString: 512 };

/** Keeps the lines nearest the error: the last of `pre_context`, the first of `post_context`. */
function nearestLines(lines: string[], side: "pre" | "post"): string[] {
  return side === "pre" ? lines.slice(-MAX_CONTEXT_LINES) : lines.slice(0, MAX_CONTEXT_LINES);
}

/**
 * Whether a frame is the app's own code. The SDK's flag wins, with one
 * exception: when the stack trace names the package (assembly or binary) of
 * its frames and this frame has none, the frame is code the runtime generated
 * (a reflection stub, a dynamic method), whatever the SDK said. Such a frame
 * appears only after the runtime warms up, so counting it would split one
 * crash into two issues. The .NET SDK marks these in-app because their module
 * is "(unknown)", which none of its exclusions match.
 */
function isInApp(raw: WireFrame, packaged: boolean): boolean {
  if (packaged && raw.package === null) {
    return false;
  }

  return raw.in_app ?? !looksLikeLibrary({ ...raw, absPath: raw.abs_path });
}

const RELATIVE_ADDRESS = /^rel:(\d+)$/;

/**
 * The debug id of the image a frame's address is relative to. Only "rel:N"
 * names an image; "abs" and absent modes are native addresses that would
 * need symbolication to place, which Zentry does not do.
 */
function debugIdOf(raw: WireFrame, images: DebugImages): string | null {
  const index = RELATIVE_ADDRESS.exec(raw.addr_mode ?? "")?.[1];
  const id = index === undefined ? null : (images[Number(index)]?.debug_id ?? null);

  return id === null ? null : id.toLowerCase();
}

type FrameSource = { packaged: boolean; images: DebugImages };

function toStoredFrame(raw: WireFrame, source: FrameSource): StoredFrame {
  const located = {
    filename: raw.filename,
    absPath: raw.abs_path,
    module: raw.module,
    function: raw.function,
  };

  return {
    ...located,
    package: raw.package,
    debugId: debugIdOf(raw, source.images),
    lineno: raw.lineno,
    colno: raw.colno,
    inApp: isInApp(raw, source.packaged),
    contextLine: raw.context_line,
    preContext: nearestLines(raw.pre_context, "pre"),
    postContext: nearestLines(raw.post_context, "post"),
    vars: raw.vars === null ? null : scrubObject(trimObject(raw.vars, VARS_LIMITS)),
  };
}

/** Frames are kept in SDK order: oldest call first, crash site last. */
export function toStoredFrames(stacktrace: WireStacktrace, images: DebugImages): StoredFrame[] {
  const { frames } = stacktrace;
  const half = MAX_FRAMES / 2;

  const kept =
    frames.length > MAX_FRAMES ? [...frames.slice(0, half), ...frames.slice(-half)] : frames;

  // Decided over every frame, before any are dropped.
  const packaged = frames.some((frame) => frame.package !== null);

  return kept.map((frame) => toStoredFrame(frame, { packaged, images }));
}
