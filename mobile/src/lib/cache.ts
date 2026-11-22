// The one data cache, kept on disk between launches. Opening the app shows
// the issues, monitors and projects from last time straight away, and every
// screen refetches behind them; the Worker's data changes slowly enough that
// a minutes-old list is far better than an empty one.
//
// The client lives here at module scope, not in the root layout, because the
// background tasks (background.ts) fill the same cache with no React tree
// mounted: from a push, or WorkManager waking the app.

import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import { QueryClient } from "@tanstack/react-query";
import type { Query } from "@tanstack/react-query";
import {
  persistQueryClientRestore,
  persistQueryClientSave,
} from "@tanstack/react-query-persist-client";
import type { PersistQueryClientOptions } from "@tanstack/react-query-persist-client";
import Storage from "expo-sqlite/kv-store";
import * as Updates from "expo-updates";

const DAY = 24 * 60 * 60 * 1000;

/**
 * How long anything survives, on disk and in memory. A query is dropped from
 * the persisted copy once it is garbage collected, so gcTime has to be at
 * least maxAge or the cache would forget lists the user has not opened in
 * the last five minutes (React Query's default).
 */
const KEEP = 7 * DAY;

declare module "@tanstack/react-query" {
  interface Register {
    queryMeta: {
      /** False keeps a query in memory only. See queries.ts, eventQuery. */
      persist?: false;
    };
  }
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Cached data shows at once whatever its age; past this, a screen that
      // mounts or an app that comes back to the foreground refetches it in
      // the background.
      staleTime: 15_000,
      gcTime: KEEP,
      retry: 1,
    },
  },
});

/**
 * A new JavaScript bundle may change what the Worker's responses look like
 * (the contract both compile against), so each update starts from an empty
 * cache rather than rendering shapes it no longer knows. A development build
 * has no update id; there the cache outlives code changes, and reinstalling
 * clears it.
 */
const buster = Updates.updateId ?? "development";

function persisted(query: Query): boolean {
  return query.state.status === "success" && query.meta?.persist !== false;
}

export const persistOptions: Omit<PersistQueryClientOptions, "queryClient"> = {
  // SQLite rather than AsyncStorage: the whole cache is one value, and
  // Android's AsyncStorage reads values through a 2 MB cursor window.
  persister: createAsyncStoragePersister({ storage: Storage, key: "zentry.queries" }),
  maxAge: KEEP,
  buster,
  dehydrateOptions: { shouldDehydrateQuery: persisted },
};

/** Loads the cache from disk into the client. The root layout's provider does this for the UI. */
export function restoreCache(): Promise<void> {
  return persistQueryClientRestore({ queryClient, ...persistOptions });
}

/** Writes the client to disk now, for a background task about to end. */
export function saveCache(): Promise<void> {
  return persistQueryClientSave({ queryClient, ...persistOptions });
}
