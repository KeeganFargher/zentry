// Fields derived from a normalized event: title, culprit and issue metadata.

import type { IssueMetadata, StoredEvent, StoredException, StoredFrame } from "@/shared/contract";

import { firstLine } from "./parameterize";
import { cut } from "./trim";

const MAX_TITLE = 200;

export const UNLABELED = "<unlabeled event>";

/** The frame an issue is "in": of the last exception, the last in-app frame, else the last frame. */
export function culpritFrame(exceptions: StoredException[]): StoredFrame | null {
  const frames = exceptions.at(-1)?.frames ?? [];

  return frames.findLast((frame) => frame.inApp) ?? frames.at(-1) ?? null;
}

type ExceptionSummary = Omit<IssueMetadata, "logger">;

function summarize(exceptions: StoredException[]): ExceptionSummary {
  const exception = exceptions.at(-1);
  const frame = culpritFrame(exceptions);
  const value = exception?.value ?? null;

  return {
    type: exception?.type ?? null,
    value: value === null ? null : cut(firstLine(value), MAX_TITLE),
    filename: frame?.filename ?? null,
    function: frame?.function ?? null,
  };
}

export function deriveMetadata(event: StoredEvent): IssueMetadata {
  return { ...summarize(event.exceptions), logger: event.logger ?? null };
}

/** `"{type}: {value}"` of the last exception, else the first line of `formatted`. */
export function deriveTitle(exceptions: StoredException[], formatted: string): string {
  const { type, value } = summarize(exceptions);
  const parts = [type, value].filter((part) => part !== null);

  if (parts.length > 0) {
    return cut(parts.join(": "), MAX_TITLE);
  }

  const line = firstLine(formatted);

  return line === "" ? UNLABELED : cut(line, MAX_TITLE);
}

/** Where the crash happened, else `fallback` (the transaction, or empty). */
export function deriveCulprit(exceptions: StoredException[], fallback: string): string {
  const frame = culpritFrame(exceptions);
  const location = frame?.module ?? frame?.filename ?? null;

  if (frame === null || location === null) {
    return fallback;
  }

  return frame.function === null || frame.function === "?"
    ? location
    : `${location} in ${frame.function}`;
}
