// One issue with one of its events: the latest by default.

import type { ApiActivity, ApiEventDetail, ApiIssue, IssueStatus } from "@contract";
import { useEffect } from "react";
import type { JSX } from "react";

import { Link, Notice } from "~/components/basics";
import { useConfirm } from "~/components/overlays";
import { api } from "~/lib/api";
import { issueTitle } from "~/lib/issue";
import { useResource } from "~/lib/resource";
import type { Resource } from "~/lib/resource";
import { navigate } from "~/lib/router";
import { toast } from "~/lib/toast";
import { MonitorDetail } from "~/pages/monitors/detail";

import { EventId, EventNav, EventSummary } from "./event-nav";
import { EventSections, sectionList } from "./event-sections";
import { IssueGraph } from "./issue-graph";
import { IssueHeader } from "./issue-header";
import { useDocumentTitle } from "./issue-list-parts";
import { Activity, Seen } from "./issue-sidebar";

type DetailProps = { org: string; issueId: string; eventId: string | null };

type ViewProps = { org: string; issue: ApiIssue; which: string; detail: Resource<ApiEventDetail> };

function MissingEvent({ org, issue, which }: Omit<ViewProps, "detail">): JSX.Element {
  return (
    <div className="empty-state">
      <strong>We couldn&apos;t track down that event ({which})</strong>
      <span>It may have been deleted by retention, or the link may be wrong.</span>
      <Link to={`/${org}/issues/${issue.id}/`}>Show the latest event</Link>
    </div>
  );
}

function EventView({ org, issue, which, detail }: ViewProps): JSX.Element {
  const issueId = String(issue.id);
  const named = which !== "latest" && which !== "oldest";

  return (
    <>
      <EventNav org={org} issue={issue} which={which} detail={detail.data} />
      <div className="event-panel">
        {detail.data === null && detail.error !== null && named && (
          <MissingEvent org={org} issue={issue} which={which} />
        )}
        {detail.data === null && (detail.error === null || !named) && (
          <Notice loading={detail.loading} error={detail.error} onRetry={detail.reload} />
        )}
        {detail.data !== null && (
          <>
            <EventId
              org={org}
              issueId={issueId}
              event={detail.data.event}
              sections={sectionList(detail.data.event)}
            />
            <EventSummary event={detail.data.event} />
            <EventSections org={org} event={detail.data.event} />
          </>
        )}
      </div>
    </>
  );
}

const DONE = new Map<IssueStatus, string>([
  ["resolved", "Resolved"],
  ["ignored", "Archived"],
  ["unresolved", "Unresolved"],
]);

type Actions = {
  setStatus: (status: IssueStatus) => Promise<void>;
  remove: () => void;
  dialog: JSX.Element | null;
};

type ActionTarget = { org: string; issue: Resource<ApiIssue>; activity: Resource<ApiActivity[]> };

/** Status changes with an Undo, and a confirmed delete. */
function useIssueActions({ org, issue, activity }: ActionTarget): Actions {
  const [ask, dialog] = useConfirm();

  const setStatus = async (status: IssueStatus): Promise<void> => {
    const current = issue.data;

    if (current === null) {
      return;
    }

    await api.setStatus(org, [current.id], status);
    issue.reload();
    activity.reload();
    toast(`${DONE.get(status) ?? status} ${current.shortId}`, () => void setStatus(current.status));
  };

  const destroy = async (): Promise<void> => {
    const current = issue.data;

    if (current !== null) {
      await api.deleteIssue(org, String(current.id));
      toast("Issue deleted");
      navigate(`/${org}/issues/`);
    }
  };

  const remove = (): void =>
    ask({
      title: "Delete this issue?",
      message: "The issue and all of its events are deleted. This cannot be undone.",
      confirm: "Delete",
      danger: true,
      onConfirm: () => void destroy(),
    });

  return { setStatus, remove, dialog };
}

/** Opening an issue is what marks it as seen for this user. */
function useMarkSeen(org: string, issue: ApiIssue | null): void {
  const unseen = issue?.hasSeen === false;
  const id = issue?.id ?? null;

  useEffect(() => {
    if (unseen && id !== null) {
      void api.markSeen(org, String(id));
    }
  }, [unseen, org, id]);
}

export function IssueDetail({ org, issueId, eventId }: DetailProps): JSX.Element {
  const which = eventId ?? "latest";
  const issue = useResource(`issue:${org}:${issueId}`, () => api.issue(org, issueId));
  const stats = useResource(`stats:${org}:${issueId}`, () => api.stats(org, issueId));
  const tags = useResource(`tags:${org}:${issueId}`, () => api.tags(org, issueId));
  const activity = useResource(`activity:${org}:${issueId}`, () => api.activity(org, issueId));

  const detail = useResource(`event:${org}:${issueId}:${which}`, () =>
    api.event(org, issueId, which),
  );

  const actions = useIssueActions({ org, issue, activity });

  useMarkSeen(org, issue.data);
  useDocumentTitle(
    issue.data === null ? "Issue" : `${issue.data.shortId} - ${issueTitle(issue.data)}`,
  );

  if (issue.data === null) {
    return <Notice loading={issue.loading} error={issue.error} onRetry={issue.reload} />;
  }

  if (issue.data.monitorId !== undefined) {
    return <MonitorDetail org={org} id={issue.data.monitorId} />;
  }

  return (
    <>
      <IssueHeader
        org={org}
        issue={issue.data}
        activity={activity.data ?? []}
        onStatus={(status) => void actions.setStatus(status)}
        onDelete={actions.remove}
      />
      <div className="detail">
        <div className="detail-main">
          <IssueGraph
            org={org}
            issue={issue.data}
            stats={stats.data}
            tags={tags.data ?? []}
            current={detail.data?.event.timestamp ?? null}
          />
          <EventView org={org} issue={issue.data} which={which} detail={detail} />
        </div>
        <aside className="detail-side">
          <Seen issue={issue.data} />
          <Activity issue={issue.data} entries={activity.data ?? []} />
        </aside>
      </div>
      {actions.dialog}
    </>
  );
}
