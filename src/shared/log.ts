// The only place that writes to the console. Workers Logs picks these up as
// structured entries.

import type { Json } from "./contract";

type Fields = { [key: string]: Json };

export function logInfo(message: string, fields: Fields = {}): void {
  console.log(JSON.stringify({ level: "info", message, ...fields }));
}

export function logError(message: string, fields: Fields = {}): void {
  console.error(JSON.stringify({ level: "error", message, ...fields }));
}

export function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
