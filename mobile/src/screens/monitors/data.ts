// The monitor screens' queries. Timelines cover "the last N days", but the
// window is rounded to five minutes: with the clock's own millisecond as the
// end, every minute's tick (useNow) would be a new query key and a refetch.

import type { ApiMonitor, MonitorDetail, MonitorTimeline } from "@contract";
import { useQuery } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";

import { useNow } from "~/lib/clock";
import { useOrg } from "~/lib/organization";
import { useApi } from "~/lib/session";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const STEP = 5 * MINUTE;

export function useMonitors(): UseQueryResult<ApiMonitor[]> {
  const api = useApi();
  const org = useOrg();

  // Refetched as often as the timelines move on, so a row's health tag never
  // trails a new red tick for long.
  return useQuery({
    queryKey: ["monitors", org],
    queryFn: () => api.monitors(org),
    refetchInterval: STEP,
  });
}

export function useMonitorDetail(id: string): UseQueryResult<MonitorDetail> {
  const api = useApi();
  const org = useOrg();

  return useQuery({
    queryKey: ["monitor", org, id],
    queryFn: () => api.monitor(org, id),
    refetchInterval: STEP,
  });
}

/**
 * The last `days` of a monitor's ticks in `buckets` columns. The end is the
 * next five-minute mark, so the newest check-in is always inside the window.
 */
export function useTimeline(
  id: string,
  days: number,
  buckets: number,
): UseQueryResult<MonitorTimeline> {
  const api = useApi();
  const org = useOrg();
  const until = Math.ceil(useNow() / STEP) * STEP;
  const since = until - days * DAY;

  return useQuery({
    queryKey: ["monitor-timeline", org, id, since, until, buckets],
    queryFn: () => api.monitorTimeline(org, id, { since, until, buckets }),
    // A new window keeps the old ticks on screen until its own arrive.
    placeholderData: (previous) => previous,
  });
}
