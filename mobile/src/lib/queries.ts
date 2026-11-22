// The queries more than one place loads: the screens, and the background
// refresh (background.ts) that fills the cache before they open. Sharing the
// options is what makes that work: a background fetch lands under exactly
// the key the screen will read.

import type {
  ApiEventDetail,
  ApiIssue,
  ApiIssueList,
  ApiMe,
  ApiMonitor,
  ApiProject,
} from "@contract";
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import type {
  InfiniteData,
  QueryClient,
  QueryKey,
  QueryKeyWithDataTag,
  UnusedSkipTokenInfiniteOptions,
  UnusedSkipTokenOptions,
} from "@tanstack/react-query";

import type { Api } from "./api";

/** What queryOptions returns for a query with a queryFn and no initial data. */
type Options<T> = UnusedSkipTokenOptions<T> & QueryKeyWithDataTag<QueryKey, T>;

/** Lists page by cursor; the first page has none. */
type Cursor = string | null;

type ListPages = InfiniteData<ApiIssueList, Cursor>;

type ListOptions = UnusedSkipTokenInfiniteOptions<
  ApiIssueList,
  Error,
  ListPages,
  QueryKey,
  Cursor
> &
  QueryKeyWithDataTag<QueryKey, InfiniteData<ApiIssueList>>;

/**
 * Widens a key to QueryKey. Inferred keys are mutable tuples, which the
 * option types below (written for QueryKey) do not accept back.
 */
function key(parts: QueryKey): QueryKey {
  return parts;
}

/** An issue of an organization: what every per-issue query is keyed by. */
export type IssueRef = { org: string; issueId: number };

export function meQuery(api: Api): Options<ApiMe> {
  return queryOptions({ queryKey: key(["me"]), queryFn: () => api.me() });
}

export function projectsQuery(api: Api, org: string): Options<ApiProject[]> {
  return queryOptions({ queryKey: key(["projects", org]), queryFn: () => api.projects(org) });
}

export function monitorsQuery(api: Api, org: string): Options<ApiMonitor[]> {
  return queryOptions({ queryKey: key(["monitors", org]), queryFn: () => api.monitors(org) });
}

const FIRST_PAGE: Cursor = null;

/** The issue list for one set of filters, as the API's query string. */
export function issueListQuery(api: Api, org: string, filters: URLSearchParams): ListOptions {
  return infiniteQueryOptions({
    queryKey: key(["issues", org, "list", filters.toString()]),
    queryFn: ({ pageParam }) => {
      const page = new URLSearchParams(filters);

      if (pageParam !== null) {
        page.set("cursor", pageParam);
      }

      return api.issues(org, page);
    },
    initialPageParam: FIRST_PAGE,
    getNextPageParam: (last) => last.nextCursor,
  });
}

export function issueQuery(api: Api, { org, issueId }: IssueRef): Options<ApiIssue> {
  return queryOptions({
    queryKey: key(["issues", org, issueId]),
    queryFn: () => api.issue(org, issueId),
  });
}

/**
 * One event in full: the stack trace, breadcrumbs, contexts. Kept in memory
 * only. Events run to tens or hundreds of kilobytes, and the persister writes
 * the whole cache as one value after every change, so persisting them would
 * make each write as large as every event opened that week; the issue around
 * it (header, chart, tags) is what is persisted.
 */
export function eventQuery(
  api: Api,
  { org, issueId }: IssueRef,
  which: string,
): Options<ApiEventDetail> {
  return queryOptions({
    queryKey: key(["issues", org, issueId, "event", which]),
    queryFn: () => api.event(org, issueId, which),
    meta: { persist: false },
    gcTime: 30 * 60 * 1000,
  });
}

/** Every cached issue list of the organization, with when each was fetched. */
function cachedLists(client: QueryClient, org: string): { pages: ListPages; updatedAt: number }[] {
  return client
    .getQueriesData<ListPages>({ queryKey: ["issues", org, "list"] })
    .flatMap(([listKey, pages]) => {
      const state = client.getQueryState(listKey);

      // Both come from the same cache entry; one without the other is a list
      // whose first fetch has not landed.
      return pages === undefined || state === undefined
        ? []
        : [{ pages, updatedAt: state.dataUpdatedAt }];
    });
}

/**
 * The issue as some cached list last saw it, and when: the newest copy across
 * every filter set. The list and the issue endpoints serialize issues the
 * same way (src/api/issues.ts), so this is the issue itself, not a preview,
 * and the issue screen renders it while its own fetch is in flight.
 */
export function issueFromLists(
  client: QueryClient,
  { org, issueId }: IssueRef,
): { issue: ApiIssue; updatedAt: number } | undefined {
  const copies = cachedLists(client, org).flatMap(({ pages, updatedAt }) =>
    pages.pages
      .flatMap((page) => page.issues)
      .filter(({ id }) => id === issueId)
      .map((issue) => ({ issue, updatedAt })),
  );

  return copies.reduce<(typeof copies)[number] | undefined>(
    (newest, copy) => (newest === undefined || copy.updatedAt > newest.updatedAt ? copy : newest),
    undefined,
  );
}

/**
 * Applies a change to the issue wherever it is cached: its own query and
 * every list page that holds it. For changes the app knows the outcome of,
 * so the screens agree without refetching every list.
 */
export function patchIssue(
  client: QueryClient,
  { org, issueId }: IssueRef,
  patch: Partial<ApiIssue>,
): void {
  const apply = (issue: ApiIssue): ApiIssue =>
    issue.id === issueId ? { ...issue, ...patch } : issue;

  client.setQueryData<ApiIssue>(["issues", org, issueId], (issue) =>
    issue === undefined ? undefined : apply(issue),
  );

  client.setQueriesData<ListPages>({ queryKey: ["issues", org, "list"] }, (data) =>
    data === undefined
      ? undefined
      : {
          ...data,
          pages: data.pages.map((page) => ({ ...page, issues: page.issues.map(apply) })),
        },
  );
}
