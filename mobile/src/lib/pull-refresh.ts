// Pull-to-refresh that spins only for the pull. A query's own `isRefetching`
// is also true for every background refetch (a screen mounting over cached
// data, the app coming back to the foreground), which put a spinner over
// data that was already on screen; those refetches stay silent, and the
// rows simply change when they land.

import { useState } from "react";

export type PullRefresh = { refreshing: boolean; onRefresh: () => void };

/** `run` refetches; failures show where the screen already shows query errors. */
export function usePullRefresh(run: () => Promise<void>): PullRefresh {
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = (): void => {
    setRefreshing(true);
    void run().finally(() => setRefreshing(false));
  };

  return { refreshing, onRefresh };
}
