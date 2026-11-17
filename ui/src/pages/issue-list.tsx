// The issue list: filters, bulk status changes, paging and real-time updates.

import type { ApiIssue, ApiProject, IssueStatus } from "@contract";
import type { ComponentProps, JSX } from "react";

import { Notice } from "~/components/basics";
import { useConfirm } from "~/components/overlays";
import type { Confirmation } from "~/components/overlays";
import { api } from "~/lib/api";
import { useResource } from "~/lib/resource";
import { replaceQuery, useUrl } from "~/lib/router";
import { useFlag } from "~/lib/storage";

import { applyStatus, confirmation, copyItems, needsConfirming, useSelection } from "./issue-bulk";
import type { Selection } from "./issue-bulk";
import { IssueFilters } from "./issue-filters";
import { effectiveQuery, useLaterPages, useLive } from "./issue-list-data";
import { EmptyIssues, LiveButton, useDocumentTitle, viewTitle } from "./issue-list-parts";
import { IssueRow, IssueRowHead, SkeletonRows } from "./issue-row";

type TableProps = {
  org: string;
  issues: ApiIssue[];
  selection: Selection;
  loading: boolean;
  onApply: (status: IssueStatus) => void;
};

function IssueTable({ org, issues, selection, loading, onApply }: TableProps): JSX.Element {
  return (
    <>
      {(issues.length > 0 || loading) && (
        <IssueRowHead
          selected={selection.ids.size}
          total={issues.length}
          onToggleAll={selection.toggleAll}
          onApply={onApply}
          more={copyItems(org, selection.chosen)}
        />
      )}
      {loading && <SkeletonRows />}
      {issues.map((issue, index) => (
        <IssueRow
          key={issue.id}
          org={org}
          issue={issue}
          selected={selection.ids.has(issue.id)}
          onToggle={(range) => selection.toggle(index, range)}
        />
      ))}
    </>
  );
}

type ApplyProps = {
  org: string;
  issues: ApiIssue[];
  selection: Selection;
  refresh: () => void;
  ask: (request: Confirmation) => void;
};

/** A bulk status change, confirmed first when it covers a whole page. */
function bulkApply(
  { org, issues, selection, refresh, ask }: ApplyProps,
  status: IssueStatus,
): void {
  const { chosen } = selection;

  const run = (): void => {
    selection.clear();
    void applyStatus({ org, issues: chosen, refresh }, status);
  };

  if (needsConfirming(chosen, issues.length)) {
    ask(confirmation(chosen.length, status, run));
  } else {
    run();
  }
}

function withFilter(url: URLSearchParams, name: string, value: string): URLSearchParams {
  const next = new URLSearchParams(url);

  next.set(name, value);

  return next;
}

function withoutFilter(url: URLSearchParams, name: string): URLSearchParams {
  const next = new URLSearchParams(url);

  next.delete(name);

  return next;
}

/** A filter change rewrites the URL and drops the selection, whose issues may no longer show. */
function filterProps(
  url: URLSearchParams,
  projects: ApiProject[],
  selection: Selection,
): ComponentProps<typeof IssueFilters> {
  const filterBy = (next: URLSearchParams): void => {
    selection.clear();
    replaceQuery(next);
  };

  return {
    query: url,
    projects,
    onSet: (name, value) => filterBy(withFilter(url, name, value)),
    onClear: (name) => filterBy(withoutFilter(url, name)),
  };
}

export function IssueList({ org }: { org: string }): JSX.Element {
  const url = useUrl().searchParams;
  const query = effectiveQuery(url);
  const [live, setLive] = useFlag("realtime", false);
  const [ask, dialog] = useConfirm();
  const projects = useResource(`projects:${org}`, () => api.projects(org));
  const first = useResource(`issues:${org}:${query.toString()}`, () => api.issues(org, query));
  const pages = useLaterPages(org, query.toString(), first.data);
  const selection = useSelection(pages.issues);
  const title = viewTitle(url, projects.data ?? []);

  useDocumentTitle(title);
  useLive(live, first.reload);

  const refresh = (): void => {
    pages.reset();
    first.reload();
  };

  const bulk: ApplyProps = { org, issues: pages.issues, selection, refresh, ask };

  return (
    <>
      <header className="topbar">
        <h1>{title}</h1>
        <span className="spacer" />
        <LiveButton on={live} onChange={setLive} />
      </header>
      <div className="content">
        <IssueFilters {...filterProps(url, projects.data ?? [], selection)} />
        <div className="panel issue-table">
          <IssueTable
            org={org}
            issues={pages.issues}
            selection={selection}
            loading={first.data === null && first.error === null}
            onApply={(status) => bulkApply(bulk, status)}
          />
          {first.error !== null && (
            <Notice loading={false} error={first.error} onRetry={first.reload} />
          )}
          {first.data !== null && pages.issues.length === 0 && (
            <EmptyIssues org={org} query={url} projects={projects.data} />
          )}
        </div>
        {pages.nextCursor !== null && (
          <div className="more">
            <button type="button" onClick={() => void pages.loadMore()}>
              Load more
            </button>
          </div>
        )}
      </div>
      {dialog}
    </>
  );
}
