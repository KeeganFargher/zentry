// Short confirmations in the corner of the screen ("Resolved 3 issues"),
// optionally with an Undo. A module-level store, so any handler can raise one.

import { useSyncExternalStore } from "react";

export type Toast = { id: number; message: string; undo: (() => void) | null };

const LIFETIME = 4000;

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function publish(next: Toast[]): void {
  toasts = next;

  for (const notify of listeners) {
    notify();
  }
}

export function dismiss(id: number): void {
  publish(toasts.filter((entry) => entry.id !== id));
}

export function toast(message: string, undo: (() => void) | null = null): void {
  const id = nextId;

  nextId += 1;
  publish([...toasts.slice(-2), { id, message, undo }]);
  setTimeout(() => dismiss(id), LIFETIME);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  return () => listeners.delete(listener);
}

export function useToasts(): Toast[] {
  return useSyncExternalStore(subscribe, () => toasts);
}

/** Copies text and says so. */
export async function copyText(text: string, message: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(message);
  } catch {
    toast("Could not copy to the clipboard");
  }
}
