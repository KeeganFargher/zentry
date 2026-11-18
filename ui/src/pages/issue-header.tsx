// The top of the issue page: breadcrumb, title, message, status, counts and
// actions. A resolved or archived issue gets a banner in place of the actions.

import type { ApiActivity, ApiIssue, IssueStatus } from "@contract";
import type { JSX } from "react";

import { Count, LevelBar, Link, Platform, TimeSince } from "~/components/basics";
import { Icon } from "~/components/icons";
import { CopyButton, Menu } from "~/components/overlays";
import { Clipped, Tooltip } from "~/components/tooltip";
import { api, ApiFailure } from "~/lib/api";
import { useNow } from "~/lib/clock";
import { issueMessage, issueTitle, substatus } from "~/lib/issue";
import { useResource } from "~/lib/resource";
import { toast } from "~/lib/toast";

type HeaderProps = {
  org: string;
  issue: ApiIssue;
  activity: ApiActivity[];
  onStatus: (status: IssueStatus) => void;
  onDelete: () => void;
};

const STATUS_HELP = new Map([
  ["New", "First seen within the last 7 days."],
  ["Ongoing", "Open for more than 7 days."],
  ["Regressed", "Was resolved, then happened again."],
  ["Resolved", "Marked as fixed. A new event reopens it as regressed."],
  ["Archived", "Hidden from the feed. New events are still counted."],
]);

function OpenActions({
  onStatus,
  onDelete,
}: Pick<HeaderProps, "onStatus" | "onDelete">): JSX.Element {
  return (
    <div className="actions">
      <button type="button" className="primary" onClick={() => onStatus("resolved")}>
        Resolve
      </button>
      <button type="button" onClick={() => onStatus("ignored")}>
        Archive
      </button>
      <Menu label="More actions" items={[{ label: "Delete", danger: true, onSelect: onDelete }]}>
        <Icon name="more" size={14} />
      </Menu>
    </div>
  );
}

/** "Resolved · dev@example.com resolved this 5 minutes ago", with the way back. */
function ClosedBanner({
  issue,
  activity,
  onStatus,
  onDelete,
}: Omit<HeaderProps, "org">): JSX.Element {
  const resolved = issue.status === "resolved";
  const latest = activity.find((entry) => entry.type === issue.status);
  const who = latest?.userEmail ?? "Zentry";

  return (
    <div className={resolved ? "actions closed resolved" : "actions closed archived"}>
      <Icon name={resolved ? "release" : "environment"} />
      <strong>{resolved ? "Resolved" : "Archived"}</strong>
      {latest !== undefined && (
        <span className="muted">
          {who} {resolved ? "resolved" : "archived"} this issue{" "}
          <TimeSince at={latest.createdAt} label={resolved ? "Resolved" : "Archived"} />
        </span>
      )}
      <span className="spacer" />
      <button type="button" className="primary" onClick={() => onStatus("unresolved")}>
        {resolved ? "Unresolve" : "Unarchive"}
      </button>
      <Menu label="More actions" items={[{ label: "Delete", danger: true, onSelect: onDelete }]}>
        <Icon name="more" size={14} />
      </Menu>
    </div>
  );
}

/**
 * Follow or unfollow the issue's workflow emails. Changing an issue's status
 * follows it, so the key includes the status to reload after one.
 */
function FollowButton({ org, issue }: Pick<HeaderProps, "org" | "issue">): JSX.Element | null {
  const id = String(issue.id);

  const subscription = useResource(`subscription:${org}:${id}:${issue.status}`, () =>
    api.subscription(org, id),
  );

  if (subscription.data === null) {
    return null;
  }

  const { subscribed } = subscription.data;

  const toggle = async (): Promise<void> => {
    try {
      await api.setSubscription(org, id, !subscribed);
      toast(
        subscribed ? "Unfollowed: no more workflow emails for this issue" : "Following this issue",
      );
      subscription.reload();
    } catch (cause) {
      toast(cause instanceof ApiFailure ? cause.message : "Could not change the subscription");
    }
  };

  return (
    <Tooltip content="Workflow emails when someone resolves, archives or reopens this issue.">
      <button
        type="button"
        className="follow"
        aria-pressed={subscribed}
        onClick={() => void toggle()}
      >
        {subscribed ? "Unfollow" : "Follow"}
      </button>
    </Tooltip>
  );
}

function Breadcrumb({ org, issue }: Pick<HeaderProps, "org" | "issue">): JSX.Element {
  return (
    <header className="topbar">
      <Link to={`/${org}/issues/`}>Issues</Link>
      <span className="sep">/</span>
      <Platform name={issue.platform} />
      <Tooltip content="This identifier is unique across your organization and can be used to reference an issue.">
        <span className="dotted">{issue.shortId}</span>
      </Tooltip>
      <CopyButton text={issue.shortId} message="Copied the short ID" label="Copy short ID" />
      <span className="spacer" />
      <FollowButton org={org} issue={issue} />
      <Link to={`/${org}/issues/?project=${issue.projectId}`}>{issue.projectSlug}</Link>
    </header>
  );
}

export function IssueHeader(props: HeaderProps): JSX.Element {
  const { org, issue } = props;
  const now = useNow();
  const message = issueMessage(issue);
  const status = substatus(issue, now);
  const subtitle = issue.metadata.type === null ? "" : issue.culprit;

  return (
    <>
      <Breadcrumb org={org} issue={issue} />
      <div className="issue-head">
        <div className="clip spacer">
          <h1>
            <Clipped text={issueTitle(issue)} />
          </h1>
          <div className="issue-message">
            <LevelBar level={issue.level} />
            {message === null ? (
              <span className="faint">(No error message)</span>
            ) : (
              <Clipped text={message} />
            )}
          </div>
          <div className="status-row">
            <Tooltip content={STATUS_HELP.get(status) ?? status} className="substatus dotted">
              {status}
            </Tooltip>
            {subtitle !== "" && <Clipped text={subtitle} className="divided muted" />}
          </div>
        </div>
        <div className="head-stats">
          <Link to={`/${org}/issues/${issue.id}/events/`}>
            <span className="dotted">Events (total)</span>
            <strong>
              <Count value={issue.timesSeen} />
            </strong>
          </Link>
        </div>
      </div>
      {issue.status === "unresolved" ? <OpenActions {...props} /> : <ClosedBanner {...props} />}
    </>
  );
}
