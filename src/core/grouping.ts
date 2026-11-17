// Grouping: one md5 hash per event. Follows Sentry's newstyle strategies
// (grouping/strategies/newstyle.py) with the reductions listed in DESIGN.md §7.3.

import type { StoredEvent, StoredException, StoredFrame } from "@/shared/contract";

import { expandVariables, isDefaultPart } from "./fingerprint";
import { md5Hex } from "./md5";
import { parameterize } from "./parameterize";

const CONTEXT_LINE_PLATFORMS = new Set(["javascript", "node", "python", "php", "ruby"]);
const MAX_CONTEXT_LINE = 120;
const IGNORED_FILENAMES = new Set(["<anonymous>", "[native code]"]);
const IGNORED_PATHS = new Set(["[native code]", "native code", "eval code", "<anonymous>"]);

const IGNORED_FUNCTIONS = new Set([
  "?",
  "<anonymous>",
  "<anonymous function>",
  "Anonymous function",
]);

const JAVASCRIPT_PLATFORMS = new Set(["javascript", "node"]);

// Generated class names change on every restart: CGLIB and Spring proxies,
// Hibernate proxies, JVM lambdas and dynamic proxies.
const PROXY_SUFFIXES = [
  /\$\$[A-Za-z]*By[A-Za-z]*\$\$[0-9a-f]+/g,
  /\$\$[A-Za-z]+\$\$[0-9a-f]+/g,
  /\$HibernateProxy\$\w+/g,
  /\$\$Lambda[$/\w.]*/g,
  /\$Proxy\d+/g,
  /_\$\$_\w+/g,
];

function stripProxy(name: string): string {
  return PROXY_SUFFIXES.reduce((result, pattern) => result.replace(pattern, ""), name);
}

function hashParts(parts: string[]): string {
  return md5Hex(parts.join("\u0000"));
}

function isUrl(path: string | null): boolean {
  return path !== null && /^https?:\/\//.test(path);
}

function basename(path: string): string {
  return path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1).toLowerCase();
}

/**
 * Browser rule: a frame served from a URL has minified names and a hashed
 * filename that change on every deploy, so it does not contribute until
 * source maps exist (DESIGN.md §13).
 */
function isSkipped(frame: StoredFrame, platform: string): boolean {
  if (!JAVASCRIPT_PLATFORMS.has(platform)) {
    return false;
  }

  const unmapped = platform === "javascript" && isUrl(frame.absPath ?? frame.filename);

  return unmapped || frame.function === "eval" || IGNORED_PATHS.has(frame.absPath ?? "");
}

function functionPart(name: string | null, platform: string): string | null {
  if (name === null || IGNORED_FUNCTIONS.has(name) || name.endsWith("/<")) {
    return null;
  }

  if (JAVASCRIPT_PLATFORMS.has(platform)) {
    return name.replace(/^Object\./, "");
  }

  if (platform === "ruby" && name.startsWith("block ")) {
    return "block";
  }

  return platform === "java" && name.startsWith("lambda$") ? null : stripProxy(name);
}

function filePart(frame: StoredFrame): string | null {
  if (frame.module !== null) {
    return stripProxy(frame.module);
  }

  const usable =
    frame.filename !== null && !isUrl(frame.absPath) && !IGNORED_FILENAMES.has(frame.filename);

  return usable && frame.filename !== null ? basename(frame.filename) : null;
}

function contextPart(frame: StoredFrame, platform: string): string | null {
  const line = frame.contextLine?.trim() ?? "";

  const usable =
    CONTEXT_LINE_PLATFORMS.has(platform) && line !== "" && line.length <= MAX_CONTEXT_LINE;

  return usable ? line : null;
}

function frameParts(frame: StoredFrame, platform: string): string[] {
  const parts = [
    filePart(frame),
    functionPart(frame.function, platform),
    contextPart(frame, platform),
  ];

  return parts.filter((part) => part !== null);
}

function repeatsPrevious(frame: StoredFrame, previous: StoredFrame | undefined): boolean {
  return (
    previous !== undefined &&
    frame.module === previous.module &&
    frame.filename === previous.filename &&
    frame.function === previous.function &&
    frame.lineno === previous.lineno
  );
}

function stackParts(frames: StoredFrame[], platform: string): string[] {
  const inApp = frames.filter((frame) => frame.inApp);
  const chosen = inApp.length > 0 ? inApp : frames;
  const parts: string[] = [];

  for (const [index, frame] of chosen.entries()) {
    if (!repeatsPrevious(frame, chosen[index - 1]) && !isSkipped(frame, platform)) {
      parts.push(...frameParts(frame, platform));
    }
  }

  return parts;
}

function exceptionParts(exception: StoredException, platform: string): string[] {
  const synthetic = exception.mechanism?.synthetic ?? false;
  const parts = exception.type === null || synthetic ? [] : [exception.type];
  const stack = stackParts(exception.frames, platform);

  if (stack.length === 0 && exception.value !== null) {
    parts.push(parameterize(exception.value));
  }

  return [...parts, ...stack];
}

const GROUP_TYPE = /^(?:Aggregate(?:Exception|Error)|(?:Base)?ExceptionGroup)$/;

function isExceptionGroup(exception: StoredException): boolean {
  return exception.mechanism?.exceptionGroup === true || GROUP_TYPE.test(exception.type ?? "");
}

/**
 * Exceptions in the order they hash. An exception group wraps several
 * children, which SDKs list in whatever order they finished. So each distinct
 * child counts once, in a fixed order, after the wrappers; ten failures of the
 * same kind are one issue, not ten.
 */
function exceptionComponents(event: StoredEvent): string[] {
  const entries = event.exceptions.map((exception) => ({
    wrapper: isExceptionGroup(exception),
    parts: exceptionParts(exception, event.platform),
  }));

  if (!entries.some(({ wrapper }) => wrapper)) {
    return entries.flatMap(({ parts }) => parts);
  }

  const distinct = new Map(
    entries.map(({ wrapper, parts }) => [hashParts(parts), { wrapper, parts }]),
  );

  const kept = [...distinct.entries()];
  const wrappers = kept.filter(([, entry]) => entry.wrapper);

  const children = kept
    .filter(([, entry]) => !entry.wrapper)
    .toSorted(([a], [b]) => a.localeCompare(b));

  return [...wrappers, ...children].flatMap(([, entry]) => entry.parts);
}

function defaultHash(event: StoredEvent): string {
  const fromExceptions = exceptionComponents(event);

  if (fromExceptions.length > 0) {
    return hashParts(fromExceptions);
  }

  const template = event.message?.message ?? event.message?.formatted ?? null;

  return template === null ? md5Hex("") : hashParts([parameterize(template)]);
}

export function computeHash(event: StoredEvent): string {
  const fingerprint = event.fingerprint;

  if (fingerprint === null || (fingerprint.length === 1 && isDefaultPart(fingerprint[0] ?? ""))) {
    return defaultHash(event);
  }

  return hashParts(
    fingerprint.map((part) =>
      isDefaultPart(part) ? defaultHash(event) : expandVariables(part, event),
    ),
  );
}
