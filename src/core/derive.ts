// Fields derived from a normalized event: title, culprit and issue metadata.

import type { IssueMetadata, StoredException, StoredFrame, StoredMessage } from "@/shared/contract";

import { firstLine } from "./parameterize";
import { cut } from "./trim";

const MAX_TITLE = 200;

export const UNLABELED = "<unlabeled event>";

/** The frame an issue is "in": the last in-app frame, else the last frame. */
function culpritFrame(exception: StoredException | undefined): StoredFrame | null {
  const frames = exception?.frames ?? [];

  return frames.findLast((frame) => frame.inApp) ?? frames.at(-1) ?? null;
}

export function deriveMetadata(exceptions: StoredException[]): IssueMetadata {
  const exception = exceptions.at(-1);
  const frame = culpritFrame(exception);
  const value = exception?.value ?? null;

  return {
    type: exception?.type ?? null,
    value: value === null ? null : cut(firstLine(value), MAX_TITLE),
    filename: frame?.filename ?? null,
    function: frame?.function ?? null,
  };
}

export function deriveTitle(exceptions: StoredException[], message: StoredMessage | null): string {
  const { type, value } = deriveMetadata(exceptions);
  const parts = [type, value].filter((part) => part !== null);

  if (parts.length > 0) {
    return cut(parts.join(": "), MAX_TITLE);
  }

  const line = firstLine(message?.formatted ?? "");

  return line === "" ? UNLABELED : cut(line, MAX_TITLE);
}

export function deriveCulprit(exceptions: StoredException[], transaction: string | null): string {
  const frame = culpritFrame(exceptions.at(-1));
  const location = frame?.module ?? frame?.filename ?? null;

  if (frame === null || location === null) {
    return transaction ?? "";
  }

  return frame.function === null ? location : `${location} in ${frame.function}`;
}
