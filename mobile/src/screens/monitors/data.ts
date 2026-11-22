// The monitor screens' queries. Timelines cover "the last N days", with the
// window rounded to five minutes and moved on every five.

import type { ApiMonitor, MonitorDetail, MonitorTimeline } from "@contract";
import { useQuery } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";

import { useOrg } from "~/lib/organization";
import { monitorsQuery } from "~/lib/queries";
import { useApi } from "~/lib/session";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const STEP = 5 * MINUTE;

export function useMonitors(): UseQueryResult<ApiMonitor[]> {
  const api = useApi();
  const org = useOrg();

  // Refetched as often as the timelines move on, so a row's health tag never
  // trails a new red tick for long.
  return useQuery({ ...monitorsQuery(api, org), refetchInterval: STEP });
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
 *
 * The key names the span, not the window: the window is worked out when the
 * fetch runs, and the response carries it. A key with the window in it was
 * new every five minutes, so a timeline restored from disk never matched
 * and every row started empty; this one shows the last ticks it saw and
 * moves on with the refetch.
 */
export function useTimeline(
  id: string,
  days: number,
  buckets: number,
): UseQueryResult<MonitorTimeline> {
  const api = useApi();
  const org = useOrg();

  return useQuery({
    queryKey: ["monitor-timeline", org, id, days, buckets],
    queryFn: () => {
      const until = Math.ceil(Date.now() / STEP) * STEP;

      return api.monitorTimeline(org, id, { since: until - days * DAY, until, buckets });
    },
    refetchInterval: STEP,
    // Another period keeps the old ticks on screen until its own arrive.
    placeholderData: (previous) => previous,
  });
}
