// One row of the issue list, and the header row above them.

import type { ApiIssue, IssueStatus } from "@contract";
import { useEffect, useRef } from "react";
import type { JSX, MouseEvent } from "react";

import { Age, Ago, Count, LevelBar, Link, Platform, Trend } from "~/components/basics";
import { Icon } from "~/components/icons";
import { Menu } from "~/components/overlays";
import type { MenuItem } from "~/components/overlays";
import { Clipped } from "~/components/tooltip";
import { useNow } from "~/lib/clock";
import { issueMessage, issueTitle, substatus } from "~/lib/issue";
import { navigate } from "~/lib/router";

import { TREND_PERIODS } from "./issue-list-data";
import type { TrendPeriod } from "./issue-list-data";

type RowProps = {
  org: string;
  issue: ApiIssue;
  selected: boolean;
  /** `range` extends the selection from the last row toggled (shift-click). */
  onToggle: (range: boolean) => void;
};

const loggerSearch = (org: string, logger: string): string =>
  `/${org}/issues/?tag=${encodeURIComponent(`logger:${logger}`)}`;

/**
 * Unread issues carry a dot and a bolder title. Sentry's current list uses
 * the dot alone; the weight change is Zentry's.
 */
function Summary({ org, issue }: Pick<RowProps, "org" | "issue">): JSX.Element {
  const { logger } = issue.metadata;
  const message = issueMessage(issue);
  // Message events already show their location as the message line.
  const location = issue.metadata.type === null ? "" : issue.culprit;

  return (
    <div className={issue.hasSeen ? "clip seen" : "clip unseen"}>
      <div className="issue-type">
        <Link to={`/${org}/issues/${issue.id}/`}>
          <Clipped text={issueTitle(issue)} />
        </Link>
      </div>
      <div className="issue-message">
        <LevelBar level={issue.level} />
        {message === null ? (
          <span className="faint">(No error message)</span>
        ) : (
          <Clipped text={message} />
        )}
      </div>
      <div className="issue-sub">
        <Platform name={issue.platform} />
        <span className="short-id">{issue.shortId}</span>
        {location !== "" && <Clipped text={location} className="divided" />}
        {logger !== null && (
          <Link to={loggerSearch(org, logger)} className="clip divided logger">
            {logger}
          </Link>
        )}
      </div>
    </div>
  );
}

function isControl(target: EventTarget): boolean {
  return target instanceof Element && target.closest("a, button, input, label") !== null;
}

export function IssueRow({ org, issue, selected, onToggle }: RowProps): JSX.Element {
  const now = useNow();

  // The whole row opens the issue; shift-click selects a range, cmd/ctrl-click toggles it.
  const click = (event: MouseEvent): void => {
    if (isControl(event.target)) {
      return;
    }

    if (event.shiftKey || event.metaKey || event.ctrlKey) {
      event.preventDefault();
      onToggle(event.shiftKey);

      return;
    }

    navigate(`/${org}/issues/${issue.id}/`);
  };

  return (
    <div className={selected ? "issue-row selected" : "issue-row"} onClick={click}>
      <div className="select">
        <input
          type="checkbox"
          aria-label={`Select ${issue.shortId}`}
          checked={selected}
          readOnly
          onClick={(event) => onToggle(event.shiftKey)}
        />
        {!issue.hasSeen && <span className="unread-dot" title="Unread" />}
      </div>
      <Summary org={org} issue={issue} />
      <div className="num col-last">
        <Ago at={issue.lastSeen} label="Last Seen" />
      </div>
      <div className="num col-age">
        <Age at={issue.firstSeen} label="First Seen" />
      </div>
      <div className="col-trend">
        <Trend points={issue.stats} status={substatus(issue, now)} />
      </div>
      <div className="num col-events">
        <Count value={issue.timesSeen} />
      </div>
    </div>
  );
}

type HeadProps = {
  selected: number;
  total: number;
  onToggleAll: () => void;
  onApply: (status: IssueStatus) => void;
  more: MenuItem[];
  period: TrendPeriod;
  onPeriod: (period: TrendPeriod) => void;
};

/** "Trend" with Sentry's 24h / 30d switch beside it. */
function TrendHead({ period, onPeriod }: Pick<HeadProps, "period" | "onPeriod">): JSX.Element {
  return (
    <span className="col-trend trend-head">
      <span>Trend</span>
      <span className="periods" role="group" aria-label="Trend period">
        {TREND_PERIODS.map((choice) => (
          <button
            key={choice}
            type="button"
            className={choice === period ? "period active" : "period"}
            aria-pressed={choice === period}
            onClick={() => onPeriod(choice)}
          >
            {choice}
          </button>
        ))}
      </span>
    </span>
  );
}

function BulkActions({
  selected,
  onApply,
  more,
}: Pick<HeadProps, "selected" | "onApply" | "more">): JSX.Element {
  return (
    <div className="bulk">
      <button type="button" className="small primary" onClick={() => onApply("resolved")}>
        Resolve
      </button>
      <button type="button" className="small" onClick={() => onApply("ignored")}>
        Archive
      </button>
      <button type="button" className="small" onClick={() => onApply("unresolved")}>
        Unresolve
      </button>
      <Menu label="More issue actions" items={more}>
        <Icon name="more" size={14} />
      </Menu>
      <span className="muted">{selected} selected</span>
    </div>
  );
}

/** Column titles, or the bulk actions while any row is selected. */
export function IssueRowHead(props: HeadProps): JSX.Element {
  const box = useRef<HTMLInputElement>(null);
  const some = props.selected > 0 && props.selected < props.total;

  useEffect(() => {
    if (box.current !== null) {
      box.current.indeterminate = some;
    }
  }, [some]);

  return (
    <div className="issue-row head">
      <input
        ref={box}
        type="checkbox"
        aria-label="Select all"
        checked={props.total > 0 && props.selected === props.total}
        onChange={props.onToggleAll}
      />
      {props.selected > 0 ? (
        <BulkActions selected={props.selected} onApply={props.onApply} more={props.more} />
      ) : (
        <>
          <span>Issue</span>
          <span className="num col-last">Last Seen</span>
          <span className="num col-age">Age</span>
          <TrendHead period={props.period} onPeriod={props.onPeriod} />
          <span className="num col-events">Events</span>
        </>
      )}
    </div>
  );
}

/** Placeholder rows in the table's own grid while the first page loads. */
export function SkeletonRows(): JSX.Element {
  return (
    <>
      {Array.from({ length: 6 }, (_, row) => (
        <div key={row} className="issue-row skeleton-row" aria-hidden="true">
          <span />
          <div className="skeleton">
            <span style={{ width: "45%", height: 14 }} />
            <span style={{ width: "70%", height: 12 }} />
            <span style={{ width: "30%", height: 10 }} />
          </div>
          <span className="skeleton-cell col-last" />
          <span className="skeleton-cell col-age" />
          <span className="skeleton-cell tall col-trend" />
          <span className="skeleton-cell col-events" />
        </div>
      ))}
    </>
  );
}
