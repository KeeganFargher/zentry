// The issue page's right-hand column: when it was seen, and its activity.

import type { ApiActivity, ApiIssue } from "@contract";
import { useState } from "react";
import type { JSX } from "react";

import { TimeSince } from "~/components/basics";

export function Seen({ issue }: { issue: ApiIssue }): JSX.Element {
  return (
    <div className="side-block">
      <div className="seen">
        <strong>Last seen</strong> <TimeSince at={issue.lastSeen} label="Last Seen" />
      </div>
      <div className="seen">
        <strong>First seen</strong> <TimeSince at={issue.firstSeen} label="First Seen" />
        {issue.firstRelease !== null && (
          <div className="muted small">
            in release <span className="dotted">{issue.firstRelease}</span>
          </div>
        )}
      </div>
    </div>
  );
}

const ACTIVITY_LABELS = new Map([
  ["resolved", "Resolved"],
  ["unresolved", "Marked as unresolved"],
  ["ignored", "Archived"],
  ["regressed", "Regressed"],
]);

/** Five or more entries fold down to the newest three, as on Sentry. */
const FOLD_AT = 5;
const FOLDED = 3;

type ActivityProps = { issue: ApiIssue; entries: ApiActivity[] };

export function Activity({ issue, entries }: ActivityProps): JSX.Element {
  const [all, setAll] = useState(false);
  const fold = !all && entries.length + 1 >= FOLD_AT;
  const shown = fold ? entries.slice(0, FOLDED) : entries;
  const hidden = entries.length + 1 - shown.length - (fold ? 0 : 1);

  return (
    <div className="side-block">
      <h2>Activity</h2>
      <div className="timeline">
        {shown.map((entry) => (
          <div key={entry.id} className={`activity ${entry.type}`}>
            <strong>{ACTIVITY_LABELS.get(entry.type) ?? entry.type}</strong>
            {entry.userEmail !== null && <span className="muted"> by {entry.userEmail}</span>}
            <div className="muted small">
              <TimeSince
                at={entry.createdAt}
                label={ACTIVITY_LABELS.get(entry.type) ?? entry.type}
              />
            </div>
          </div>
        ))}
        {fold && (
          <div className="more-activity">
            <button type="button" className="plain small link" onClick={() => setAll(true)}>
              View {hidden} more
            </button>
          </div>
        )}
        {!fold && (
          <div className="activity first-seen">
            <strong>First seen</strong>
            <div className="muted small">
              <TimeSince at={issue.firstSeen} label="First Seen" />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
