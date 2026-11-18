// Fields derived from a normalized event: title, culprit and issue metadata.

import type { IssueMetadata, StoredEvent, StoredException, StoredFrame } from "@/shared/contract";

import { firstLine } from "./parameterize";
import { cut } from "./trim";

const MAX_TITLE = 200;

export const UNLABELED = "<unlabeled event>";

/** Shown in place of a value that is mostly not text, such as compressed bytes read as a string. */
export const BINARY = "<binary data>";

/** Control characters, lone surrogates, private-use characters and U+FFFD (a byte that was not valid text). */
const UNPRINTABLE = /[\p{Cc}\p{Cs}\p{Co}\uFFFD]/gu;
const UNPRINTABLE_RUN = /[\p{Cc}\p{Cs}\p{Co}\uFFFD]+/gu;

/**
 * One line of a value, made fit to show as a title. Display only: grouping
 * and the stored event keep the value as it was sent. A line that is mostly
 * unprintable is binary data, and says so; otherwise each run of
 * unprintable characters becomes one U+FFFD, so the rest stays readable.
 */
export function displayLine(text: string): string {
  const line = firstLine(text).replaceAll("\t", " ");
  const unprintable = line.match(UNPRINTABLE)?.length ?? 0;

  if (unprintable * 2 > line.length) {
    return BINARY;
  }

  return line.replaceAll(UNPRINTABLE_RUN, "\uFFFD");
}

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
    value: value === null ? null : cut(displayLine(value), MAX_TITLE),
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

  const line = displayLine(formatted);

  return line === "" ? UNLABELED : cut(line, MAX_TITLE);
}

/**
 * Where the crash happened: the culprit frame's module or file, and its
 * function. A frame with a function but neither of the others (the .NET SDK
 * clears the module, and a build without symbols has no files) is named by
 * its function alone, since that is the most precise place the event gives.
 * Without a frame, `fallback` (the transaction, or empty).
 */
export function deriveCulprit(exceptions: StoredException[], fallback: string): string {
  const frame = culpritFrame(exceptions);
  const location = frame?.module ?? frame?.filename ?? null;
  const fn = frame === null || frame.function === "?" ? null : frame.function;

  if (location === null) {
    return fn === null ? fallback : cut(fn, MAX_TITLE);
  }

  return fn === null ? location : `${location} in ${fn}`;
}
