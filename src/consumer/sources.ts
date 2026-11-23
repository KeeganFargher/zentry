// Source context for a batch (core/source-context.ts): the batch's events are
// read together so each source bundle is fetched and opened once, however
// many of its events the batch holds. A crash loop sends many events from the
// same build, so this is the common case, not an optimization for a rare one.

import type { Normalized } from "@/core/normalize";
import { parseSourceBundle, readSources } from "@/core/source-bundle";
import { sourceRequest, withSourceContext } from "@/core/source-context";

/** Reads a project's source bundle for a debug id; null when none was uploaded. */
export type LoadSourceBundle = (projectId: number, debugId: string) => Promise<Uint8Array | null>;

type Wanted = { projectId: number; debugId: string; paths: Set<string> };

const keyOf = (projectId: number, debugId: string): string => `${projectId}:${debugId}`;

function wantedBy(events: Normalized[]): Map<string, Wanted> {
  const wanted = new Map<string, Wanted>();

  for (const { event } of events) {
    for (const [debugId, paths] of sourceRequest(event)) {
      const key = keyOf(event.projectId, debugId);
      const entry = wanted.get(key) ?? { projectId: event.projectId, debugId, paths: new Set() };

      for (const path of paths) {
        entry.paths.add(path);
      }

      wanted.set(key, entry);
    }
  }

  return wanted;
}

/**
 * The events, in the same positions, with source context added. A missing
 * bundle is normal (a build that uploaded none, a frame from a library the
 * SDK called in-app) and leaves frames as they are. A read that fails throws,
 * so the batch is retried; the bundle was checked when it was uploaded, so
 * one that will not open is a fault to see, not to skip.
 */
export async function withSources(
  events: (Normalized | null)[],
  load: LoadSourceBundle,
): Promise<(Normalized | null)[]> {
  const wanted = wantedBy(events.filter((event) => event !== null));
  const sources = new Map<string, Map<string, string>>();

  await Promise.all(
    [...wanted.entries()].map(async ([key, { projectId, debugId, paths }]) => {
      const bytes = await load(projectId, debugId);

      if (bytes !== null) {
        sources.set(key, readSources(parseSourceBundle(bytes), paths));
      }
    }),
  );

  if (sources.size === 0) {
    return events;
  }

  return events.map((normalized) => {
    if (normalized === null) {
      return null;
    }

    const { projectId } = normalized.event;

    const lookup = (debugId: string, path: string): string | null =>
      sources.get(keyOf(projectId, debugId))?.get(path) ?? null;

    return { ...normalized, event: withSourceContext(normalized.event, lookup) };
  });
}
