// How a stack trace's frames are grouped for display, ported from
// ui/src/pages/frames.tsx: recursion folds into one frame with a count, and in
// "Most Relevant" view each run of library frames hides behind its first.

import type { JsonObject, StoredFrame } from "@contract";

/** A frame with how many times it repeats in a row (recursion). */
export type Shown = { frame: StoredFrame; repeats: number; key: number };

export type Run = { lead: Shown; rest: Shown[] };

const MAX_PATH = 100;

function sameFrame(left: StoredFrame, right: StoredFrame): boolean {
  return (
    left.filename === right.filename &&
    left.function === right.function &&
    left.lineno === right.lineno &&
    left.module === right.module
  );
}

/** Folds identical consecutive frames into one with a repeat count. */
export function collapseRepeats(frames: StoredFrame[]): Shown[] {
  const shown: Shown[] = [];

  for (const [key, frame] of frames.entries()) {
    const last = shown.at(-1);

    if (last !== undefined && sameFrame(last.frame, frame)) {
      last.repeats += 1;
    } else {
      shown.push({ frame, repeats: 1, key });
    }
  }

  return shown;
}

/** In-app frames stand alone; consecutive library frames become one run. */
export function runsOf(frames: Shown[]): Run[] {
  const runs: Run[] = [];

  for (const shown of frames) {
    const last = runs.at(-1);

    if (!shown.frame.inApp && last !== undefined && !last.lead.frame.inApp) {
      last.rest.push(shown);
    } else {
      runs.push({ lead: shown, rest: [] });
    }
  }

  return runs;
}

/** The frame's local variables, or null when it has none. */
export function varsOf(frame: StoredFrame): JsonObject | null {
  return frame.vars !== null && Object.keys(frame.vars).length > 0 ? frame.vars : null;
}

export function isExpandable(frame: StoredFrame): boolean {
  return frame.contextLine !== null || varsOf(frame) !== null;
}

/** The absolute path, when it says more than the filename the row shows. */
export function fullPath(frame: StoredFrame): string | null {
  return frame.absPath !== null && frame.absPath !== frame.filename ? frame.absPath : null;
}

/** Long paths keep their end, which is the part that tells files apart. */
function shortPath(path: string): string {
  return path.length > MAX_PATH ? `…${path.slice(-MAX_PATH)}` : path;
}

/** Java names a frame by its class; everything else by its file. */
export function fileName(frame: StoredFrame, platform: string): string {
  const name =
    platform === "java" ? (frame.module ?? frame.filename) : (frame.filename ?? frame.module);

  return shortPath(name ?? frame.absPath ?? "<unknown>");
}

/** "12:5", or null when the SDK sent no line. */
export function position(frame: StoredFrame): string | null {
  if (frame.lineno === null) {
    return null;
  }

  return frame.colno === null ? String(frame.lineno) : `${frame.lineno}:${frame.colno}`;
}

/** The frame's lines with their numbers; the context line is at `current`. */
export function sourceLines(frame: StoredFrame, contextLine: string): [number | null, string][] {
  const first = (frame.lineno ?? 0) - frame.preContext.length;
  const lines = [...frame.preContext, contextLine, ...frame.postContext];

  return lines.map((line, index): [number | null, string] => [
    frame.lineno === null ? null : first + index,
    line,
  ]);
}
