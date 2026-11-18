// A stack trace as plain text in the style the platform itself prints,
// for the "Raw" view and for copying.

import type { StoredException, StoredFrame } from "@contract";

function heading(exception: StoredException): string {
  const type = exception.type ?? "Error";

  return exception.value === null ? type : `${type}: ${exception.value}`;
}

/** "file:line:col", or null when the SDK sent no file, as .NET without symbols. */
function where(frame: StoredFrame): string | null {
  const file = frame.filename ?? frame.absPath;

  if (file === null) {
    return null;
  }

  const line = frame.lineno === null ? "" : `:${frame.lineno}`;
  const column = frame.colno === null ? "" : `:${frame.colno}`;

  return `${file}${line}${column}`;
}

function pythonBlock(exception: StoredException): string {
  const lines = ["Traceback (most recent call last):"];

  for (const frame of exception.frames) {
    lines.push(
      `  File "${frame.absPath ?? frame.filename ?? "<unknown>"}", line ${frame.lineno ?? "?"}, in ${frame.function ?? "<module>"}`,
    );

    if (frame.contextLine !== null) {
      lines.push(`    ${frame.contextLine.trim()}`);
    }
  }

  lines.push(heading(exception));

  return lines.join("\n");
}

/** As .NET prints it: "at Function in File:line 42". */
function dotnetFrame(frame: StoredFrame): string {
  const file = frame.filename ?? frame.absPath;
  const line = frame.lineno === null ? "" : `:line ${frame.lineno}`;

  return `   at ${frame.function ?? "<unknown>"}${file === null ? "" : ` in ${file}${line}`}`;
}

/** As the JVM prints it: "at pkg.Class.method(File.java:42)". */
function jvmFrame(frame: StoredFrame): string {
  const owner = frame.module === null ? "" : `${frame.module}.`;

  return `\tat ${owner}${frame.function ?? "<unknown>"}(${where(frame) ?? "Unknown Source"})`;
}

function scriptFrame(frame: StoredFrame): string {
  const location = where(frame);

  if (frame.function === null) {
    return `    at ${location ?? "<anonymous>"}`;
  }

  return location === null ? `    at ${frame.function}` : `    at ${frame.function} (${location})`;
}

const JVM = new Set(["java", "kotlin", "scala", "groovy"]);

function frameFormat(platform: string): (frame: StoredFrame) => string {
  if (platform === "csharp") {
    return dotnetFrame;
  }

  return JVM.has(platform) ? jvmFrame : scriptFrame;
}

function frameBlock(exception: StoredException, platform: string): string {
  const format = frameFormat(platform);

  return [heading(exception), ...exception.frames.toReversed().map(format)].join("\n");
}

/** Newest exception first, each with its frames as the platform would print them. */
export function rawTrace(exceptions: StoredException[], platform: string): string {
  const blocks = exceptions
    .toReversed()
    .map((exception) =>
      platform === "python" ? pythonBlock(exception) : frameBlock(exception, platform),
    );

  return blocks.join("\n\n");
}
