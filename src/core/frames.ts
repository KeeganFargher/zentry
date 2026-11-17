// Stack frames: parsing, limits, and the default in-app rule.

import type { JsonObject, StoredFrame } from "@/shared/contract";
import {
  getArray,
  getBoolean,
  getNonEmpty,
  getNumber,
  getObject,
  objectsIn,
  stringsIn,
} from "@/shared/json";

import { looksLikeLibrary } from "./inapp";
import { scrubObject } from "./scrub";
import { cut, cutOrNull, MAX_LINE, MAX_STRING, trimObject } from "./trim";

const MAX_FRAMES = 250;
const MAX_CONTEXT_LINES = 10;
const VARS_LIMITS = { depth: 3, maxKeys: 50, maxString: 512 };

/** Keeps the lines nearest the error: the last of `pre_context`, the first of `post_context`. */
function contextLines(raw: JsonObject, key: "pre_context" | "post_context"): string[] {
  const lines = stringsIn(getArray(raw, key));

  const nearest =
    key === "pre_context" ? lines.slice(-MAX_CONTEXT_LINES) : lines.slice(0, MAX_CONTEXT_LINES);

  return nearest.map((line) => cut(line, MAX_LINE));
}

function parseVars(raw: JsonObject): JsonObject | null {
  const vars = getObject(raw, "vars");

  return vars === null ? null : scrubObject(trimObject(vars, VARS_LIMITS));
}

function parseFrame(raw: JsonObject): StoredFrame {
  const filename = cutOrNull(getNonEmpty(raw, "filename"), MAX_STRING);
  const absPath = cutOrNull(getNonEmpty(raw, "abs_path"), MAX_STRING);
  const module = cutOrNull(getNonEmpty(raw, "module"), MAX_STRING);
  const fn = cutOrNull(getNonEmpty(raw, "function"), MAX_STRING);

  return {
    filename,
    absPath,
    module,
    function: fn,
    lineno: getNumber(raw, "lineno"),
    colno: getNumber(raw, "colno"),
    inApp:
      getBoolean(raw, "in_app") ?? !looksLikeLibrary({ absPath, filename, module, function: fn }),
    contextLine: cutOrNull(getNonEmpty(raw, "context_line"), MAX_LINE),
    preContext: contextLines(raw, "pre_context"),
    postContext: contextLines(raw, "post_context"),
    vars: parseVars(raw),
  };
}

/** Frames are kept in SDK order: oldest call first, crash site last. */
export function parseFrames(stacktrace: JsonObject | null): StoredFrame[] {
  const raw = stacktrace === null ? [] : objectsIn(getArray(stacktrace, "frames"));
  const half = MAX_FRAMES / 2;
  const kept = raw.length > MAX_FRAMES ? [...raw.slice(0, half), ...raw.slice(-half)] : raw;

  return kept.map(parseFrame);
}
