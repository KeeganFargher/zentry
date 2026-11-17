// Loading for the issue list: later pages, the remembered sort, and the
// real-time refresh.

import type { ApiIssue, ApiIssueList } from "@contract";
import { useEffect, useRef, useState } from "react";

import { api } from "~/lib/api";
import { readSetting } from "~/lib/storage";

import { SORT_SETTING } from "./issue-filters";

const LIVE_INTERVAL = 5000;

type Later = { key: string; issues: ApiIssue[]; nextCursor: string | null };

/** Drops repeats, keeping the first (freshest) copy of each issue. */
function unique(issues: ApiIssue[]): ApiIssue[] {
  const ids = new Set<number>();
  const kept: ApiIssue[] = [];

  for (const issue of issues) {
    if (!ids.has(issue.id)) {
      ids.add(issue.id);
      kept.push(issue);
    }
  }

  return kept;
}

/** Pages after the first, kept only while the filters stay the same. */
export type LaterPages = {
  issues: ApiIssue[];
  nextCursor: string | null;
  loadMore: () => Promise<void>;
  reset: () => void;
};

export function useLaterPages(org: string, key: string, first: ApiIssueList | null): LaterPages {
  const [later, setLater] = useState<Later>({ key: "", issues: [], nextCursor: null });
  const current = later.key === key ? later : null;
  const nextCursor = current === null ? (first?.nextCursor ?? null) : current.nextCursor;

  const loadMore = async (): Promise<void> => {
    const query = new URLSearchParams(key);

    query.set("cursor", nextCursor ?? "");

    const page = await api.issues(org, query);

    setLater({
      key,
      issues: [...(current?.issues ?? []), ...page.issues],
      nextCursor: page.nextCursor,
    });
  };

  // A refreshed first page can now hold an issue that was on a later one.
  const issues = unique([...(first?.issues ?? []), ...(current?.issues ?? [])]);

  const reset = (): void => setLater({ key: "", issues: [], nextCursor: null });

  return { issues, nextCursor, loadMore, reset };
}

export const TREND_PERIODS = ["24h", "30d"] as const;

export type TrendPeriod = (typeof TREND_PERIODS)[number];

/**
 * The URL's filters, plus the sort remembered from last time when the URL has
 * none, plus the trend column's period.
 */
export function effectiveQuery(query: URLSearchParams, period: TrendPeriod): URLSearchParams {
  const sort = readSetting(SORT_SETTING);
  const next = new URLSearchParams(query);

  if (period !== "24h") {
    next.set("groupStatsPeriod", period);
  }

  if (!next.has("sort") && sort !== null && sort !== "date") {
    next.set("sort", sort);
  }

  return next;
}

/** Re-runs `refresh` every few seconds while `on`, skipping hidden tabs. */
export function useLive(on: boolean, refresh: () => void): void {
  const latest = useRef(refresh);

  useEffect(() => {
    latest.current = refresh;
  });

  useEffect(() => {
    const timer = setInterval(() => {
      if (on && document.visibilityState === "visible") {
        latest.current();
      }
    }, LIVE_INTERVAL);

    return () => clearInterval(timer);
  }, [on]);
}
