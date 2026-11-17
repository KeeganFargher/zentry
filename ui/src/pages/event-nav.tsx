// The bar above the event (moving between events) and the event's own
// heading rows: its id and time, and the one-line summary of where it ran.

import type { ApiEventDetail, ApiIssue, StoredEvent } from "@contract";
import type { JSX } from "react";

import { Count } from "~/components/basics";
import { Icon } from "~/components/icons";
import type { IconName } from "~/components/icons";
import { jumpTo, Segmented } from "~/components/section";
import { Tooltip } from "~/components/tooltip";
import { eventJsonUrl } from "~/lib/api";
import { useNow } from "~/lib/clock";
import { dateTime, duration, longAgo } from "~/lib/format";
import { issueTitle } from "~/lib/issue";
import { getText } from "~/lib/json";
import { rawTrace } from "~/lib/raw-trace";
import { navigate } from "~/lib/router";
import { copyText } from "~/lib/toast";

type NavProps = { org: string; issue: ApiIssue; which: string; detail: ApiEventDetail | null };

type StepProps = { to: string | null; label: string; icon: IconName };

function Step({ to, label, icon }: StepProps): JSX.Element {
  return (
    <Tooltip content={label}>
      <button
        type="button"
        className="small"
        aria-label={label}
        disabled={to === null}
        onClick={() => to !== null && navigate(to)}
      >
        <Icon name={icon} size={12} />
      </button>
    </Tooltip>
  );
}

function markdown(org: string, issue: ApiIssue, event: StoredEvent): string {
  const link = `${window.location.origin}/${org}/issues/${issue.id}/`;

  const trace =
    event.exceptions.length === 0
      ? ""
      : `\n\n## Stack Trace\n\n\`\`\`\n${rawTrace(event.exceptions, event.platform)}\n\`\`\``;

  return (
    [
      `# ${issueTitle(issue)}`,
      "",
      `**Issue:** [${issue.shortId}](${link})`,
      `**Level:** ${issue.level} · **Events:** ${issue.timesSeen} · **First seen:** ${dateTime(issue.firstSeen)}`,
      `**Event:** ${event.eventId} at ${dateTime(event.timestamp)}`,
      `**Release:** ${event.release ?? "none"} · **Environment:** ${event.environment}`,
    ].join("\n") + trace
  );
}

const WHICH = [
  ["oldest", "First"],
  ["latest", "Latest"],
] as const;

/** Links to the events either side of this one; null at either end. */
function stepLinks(base: string, detail: ApiEventDetail): [string | null, string | null] {
  const { previousEventId, nextEventId } = detail;

  return [
    previousEventId === null ? null : `${base}/${previousEventId}/`,
    nextEventId === null ? null : `${base}/${nextEventId}/`,
  ];
}

/** Event count, First / Latest, previous / next, and the way to all events. */
export function EventNav({ org, issue, which, detail }: NavProps): JSX.Element {
  const base = `/${org}/issues/${issue.id}/events`;

  const [previous, next] = detail === null ? [null, null] : stepLinks(base, detail);

  const active = which === "oldest" ? "oldest" : which === "latest" ? "latest" : "other";

  return (
    <div className="event-tabs">
      <span className="tab">
        Events <Count value={issue.timesSeen} />
      </span>
      <span className="muted small">in this issue</span>
      <span className="spacer" />
      <Segmented
        label="Event"
        options={WHICH}
        value={active === "other" ? null : active}
        onChange={(value) => navigate(`${base}/${value}/`)}
      />
      <Step to={previous} label="Previous Event" icon="previous" />
      <Step to={next} label="Next Event" icon="next" />
      <button type="button" className="small" onClick={() => navigate(`${base}/`)}>
        View More Events
      </button>
      {detail !== null && (
        <button
          type="button"
          className="small"
          onClick={() =>
            void copyText(markdown(org, issue, detail.event), "Copied the issue as Markdown")
          }
        >
          Copy as Markdown
        </button>
      )}
    </div>
  );
}

function Occurred({ event }: { event: StoredEvent }): JSX.Element {
  const now = useNow();

  const card = (
    <div className="time-card">
      <div>
        <strong>Occurred</strong> {dateTime(event.timestamp)}
      </div>
      <div>
        <strong>Received</strong> {dateTime(event.receivedAt)}
      </div>
      <div>
        <strong>Latency</strong> {duration(event.receivedAt - event.timestamp)}
      </div>
    </div>
  );

  return (
    <Tooltip content={card} className="dotted">
      {longAgo(event.timestamp, now)}
    </Tooltip>
  );
}

type IdProps = { org: string; issueId: string; event: StoredEvent; sections: [string, string][] };

export function EventId({ org, issueId, event, sections }: IdProps): JSX.Element {
  return (
    <div className="event-id">
      <Tooltip content="Copy event ID">
        <button
          type="button"
          className="plain event-id-copy"
          onClick={() => void copyText(event.eventId, "Event ID copied to clipboard")}
        >
          ID: {event.eventId.slice(0, 8)} <Icon name="copy" size={12} />
        </button>
      </Tooltip>
      <Occurred event={event} />
      <a
        className="dotted"
        href={eventJsonUrl(org, issueId, event.eventId)}
        target="_blank"
        rel="noreferrer"
      >
        JSON
      </a>
      <span className="spacer" />
      <div className="jump">
        <span>Jump to:</span>
        {sections.map(([id, label]) => (
          <button key={id} type="button" className="plain" onClick={() => jumpTo(id)}>
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

function userLabel(event: StoredEvent): string | null {
  const user = event.user;

  if (user === null) {
    return null;
  }

  return (
    getText(user, "email") ??
    getText(user, "username") ??
    getText(user, "id") ??
    getText(user, "ip_address")
  );
}

type ItemProps = { icon: IconName; title: string | null; subtitle?: string | null };

function Item({ icon, title, subtitle = null }: ItemProps): JSX.Element | null {
  return title === null ? null : (
    <span className="summary-item">
      <Icon name={icon} />
      <span>{title}</span>
      {subtitle !== null && <span className="muted">{subtitle}</span>}
    </span>
  );
}

function contextPart(event: StoredEvent, name: string, field: string): string | null {
  const value = event.contexts[name];

  return value === undefined ? null : getText(value, field);
}

/** Who and where, as Sentry's icon summary: user, browser, runtime, OS, device, release, environment. */
export function EventSummary({ event }: { event: StoredEvent }): JSX.Element {
  const browser = contextPart(event, "browser", "name");
  const runtime = contextPart(event, "runtime", "name");
  const device = contextPart(event, "device", "model") ?? contextPart(event, "device", "family");

  return (
    <div className="event-meta">
      <Item icon="user" title={userLabel(event)} />
      <Item icon="globe" title={browser} subtitle={contextPart(event, "browser", "version")} />
      {runtime !== browser && (
        <Item icon="code" title={runtime} subtitle={contextPart(event, "runtime", "version")} />
      )}
      <Item
        icon="os"
        title={contextPart(event, "os", "name")}
        subtitle={contextPart(event, "os", "version")}
      />
      <Item icon="device" title={device} />
      <Item icon="release" title={event.release} />
      <Item icon="environment" title={event.environment} />
    </div>
  );
}
