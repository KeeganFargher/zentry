// A table of every stored event of one issue.

import type { ApiEventList, ApiEventRow } from "@contract";
import { useState } from "react";
import type { JSX } from "react";

import { Link, Notice, TimeSince } from "~/components/basics";
import { Clipped } from "~/components/tooltip";
import { api } from "~/lib/api";
import { useResource } from "~/lib/resource";

type Props = { org: string; issueId: string };

function EventRow({ org, issueId, event }: Props & { event: ApiEventRow }): JSX.Element {
  return (
    <tr>
      <td>
        <Link to={`/${org}/issues/${issueId}/events/${event.eventId}/`}>
          <span className="mono">{event.eventId.slice(0, 8)}</span>
        </Link>
      </td>
      <td className="nowrap">
        <TimeSince at={event.timestamp} label="Occurred" />
      </td>
      <td className="title-cell">
        <Clipped text={event.title ?? ""} />
      </td>
      <td>{event.level}</td>
      <td>{event.environment}</td>
      <td>{event.release}</td>
      <td>{event.user}</td>
    </tr>
  );
}

type Pages = {
  events: ApiEventRow[];
  nextCursor: string | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
  loadMore: () => Promise<void>;
};

function useEventPages(org: string, issueId: string): Pages {
  const first = useResource(`events:${org}:${issueId}`, () => api.events(org, issueId));
  const [later, setLater] = useState<ApiEventList | null>(null);
  const nextCursor = (later ?? first.data)?.nextCursor ?? null;

  const loadMore = async (): Promise<void> => {
    if (nextCursor === null) {
      return;
    }

    const page = await api.eventsAfter(org, issueId, nextCursor);

    setLater({ events: [...(later?.events ?? []), ...page.events], nextCursor: page.nextCursor });
  };

  return {
    events: [...(first.data?.events ?? []), ...(later?.events ?? [])],
    nextCursor,
    loading: first.loading,
    error: first.error,
    reload: first.reload,
    loadMore,
  };
}

export function IssueEvents({ org, issueId }: Props): JSX.Element {
  const issue = useResource(`issue:${org}:${issueId}`, () => api.issue(org, issueId));
  const { events, nextCursor, loading, error, reload, loadMore } = useEventPages(org, issueId);

  return (
    <>
      <header className="topbar">
        <Link to={`/${org}/issues/`}>Issues</Link>
        <span className="sep">/</span>
        <Link to={`/${org}/issues/${issueId}/`}>{issue.data?.shortId ?? issueId}</Link>
        <span className="sep">/</span>
        <h1>All Events</h1>
      </header>
      <div className="content">
        <div className="page-head">
          <span className="muted">
            Showing {events.length.toLocaleString()} of{" "}
            {(issue.data?.timesSeen ?? events.length).toLocaleString()} events
            {nextCursor === null ? "" : " (load more for older ones)"}
          </span>
        </div>
        <div className="panel issue-table">
          <table className="rows">
            <thead>
              <tr>
                <th>Event ID</th>
                <th>Timestamp</th>
                <th>Title</th>
                <th>Level</th>
                <th>Environment</th>
                <th>Release</th>
                <th>User</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <EventRow key={event.eventId} org={org} issueId={issueId} event={event} />
              ))}
            </tbody>
          </table>
          <Notice
            loading={loading}
            error={error}
            onRetry={reload}
            empty={events.length === 0 ? "No stored events." : null}
          />
        </div>
        {nextCursor !== null && (
          <div className="more">
            <button type="button" onClick={() => void loadMore()}>
              Load more
            </button>
          </div>
        )}
      </div>
    </>
  );
}
