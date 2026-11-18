// A stack trace as plain text in the style the platform itself prints, for
// the "Raw" view and for copying. Copied from ui/src/lib/raw-trace.ts.

import type { StoredException, StoredFrame } from "@contract";

function heading(exception: StoredException): string {
  const type = exception.type ?? "Error";

  return exception.value === null ? type : `${type}: ${exception.value}`;
}

function where(frame: StoredFrame): string {
  const file = frame.filename ?? frame.absPath ?? frame.module ?? "<unknown>";
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

function managedFrame(frame: StoredFrame): string {
  const owner = frame.module === null ? "" : `${frame.module}.`;

  return `    at ${owner}${frame.function ?? "<unknown>"}(${where(frame)})`;
}

function scriptFrame(frame: StoredFrame): string {
  return frame.function === null
    ? `    at ${where(frame)}`
    : `    at ${frame.function} (${where(frame)})`;
}

const MANAGED = new Set(["java", "csharp", "kotlin", "scala", "groovy"]);

function frameBlock(exception: StoredException, platform: string): string {
  const format = MANAGED.has(platform) ? managedFrame : scriptFrame;

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
