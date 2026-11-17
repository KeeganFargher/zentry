// The Breadcrumbs section: a timeline of what happened before the event,
// newest first, starting with the event itself.

import type { StoredBreadcrumb, StoredEvent } from "@contract";
import { useState } from "react";
import type { JSX } from "react";

import { Icon } from "~/components/icons";
import type { IconName } from "~/components/icons";
import { Section, Segmented } from "~/components/section";
import { Linkified } from "~/components/text";
import { clockTime } from "~/lib/format";
import { getText, jsonText } from "~/lib/json";
import { numbered } from "~/lib/lists";
import { useChoice } from "~/lib/storage";

type Crumb = StoredBreadcrumb & { virtual?: boolean };

const SUMMARY = 5;

/** Sentry upgrades untyped crumbs by their category. */
const CATEGORY_TYPES = new Map([
  ["console", "debug"],
  ["logcat", "debug"],
  ["timber", "debug"],
  ["session", "navigation"],
  ["graphql", "query"],
  ["query", "query"],
  ["sql.query", "query"],
  ["exception", "error"],
]);

function typeOf(crumb: Crumb): string {
  const type = crumb.type ?? "default";

  if (type !== "default") {
    return type;
  }

  const category = crumb.category?.toLowerCase() ?? "";

  return CATEGORY_TYPES.get(category) ?? (category.startsWith("ui.") ? "ui" : "default");
}

const LOOKS: [types: string[], icon: IconName, tone: string][] = [
  [["error"], "error", "red"],
  [["warning"], "warning", "yellow"],
  [["navigation"], "navigation", "green"],
  [["http"], "http", "green"],
  [["query"], "query", "green"],
  [["ui", "user"], "cursor", "blue"],
  [["info"], "info", "blue"],
  [["system", "device", "network"], "device", "purple"],
  [["debug"], "console", "grey"],
];

function lookOf(type: string): [icon: IconName, tone: string] {
  const look = LOOKS.find(([types]) => types.includes(type));

  return look === undefined ? ["code", "grey"] : [look[1], look[2]];
}

/** "HTTP", "Navigation"; untyped crumbs keep their raw category. */
function titleOf(crumb: Crumb, type: string): string {
  if (crumb.virtual === true || crumb.type === null || crumb.type === "default") {
    return crumb.category ?? "generic";
  }

  if (type === "http") {
    return "HTTP";
  }

  return (crumb.category ?? type)
    .replaceAll(".", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** What the SDK always attaches and nobody reads. */
const NOISE = new Set(["arguments", "__span", "logger"]);

function Details({ crumb, type }: { crumb: Crumb; type: string }): JSX.Element | null {
  const data = crumb.data;

  if (type === "http" && data !== null) {
    const status = getText(data, "status_code");

    return (
      <div className="crumb-message">
        {getText(data, "method") ?? "GET"}: <Linkified text={getText(data, "url") ?? ""} />
        {status === null ? "" : ` [${status}]`}
      </div>
    );
  }

  const rest = data === null ? [] : Object.entries(data).filter(([key]) => !NOISE.has(key));

  return (
    <>
      {crumb.message !== null && <div className="crumb-message">{crumb.message}</div>}
      {rest.length > 0 && <div className="crumb-data">{jsonText(Object.fromEntries(rest))}</div>}
    </>
  );
}

function relative(crumb: Crumb, eventTime: number): string {
  if (crumb.timestamp === null) {
    return "";
  }

  const seconds = (eventTime - crumb.timestamp) / 1000;

  return seconds <= 0 ? "0s" : `-${seconds.toFixed(seconds < 10 ? 2 : 1)}s`;
}

type CrumbProps = { crumb: Crumb; time: string };

function Breadcrumb({ crumb, time }: CrumbProps): JSX.Element {
  const type = typeOf(crumb);
  const [icon, tone] = lookOf(type);
  const level = crumb.level === "info" ? null : crumb.level;

  return (
    <div className={crumb.virtual === true ? "crumb this-event" : "crumb"}>
      <span className={`crumb-icon ${tone}`}>
        <Icon name={icon} size={12} />
      </span>
      <div className="crumb-main">
        <div className="crumb-head">
          <span className={`crumb-title ${tone}`}>{titleOf(crumb, type)}</span>
          {crumb.virtual === true && <span className="muted"> - This event</span>}
          <span className="spacer" />
          {level !== null && <span className={`crumb-level ${level}`}>{level}</span>}
          <span className="crumb-time">{time}</span>
        </div>
        <Details crumb={crumb} type={type} />
      </div>
    </div>
  );
}

/** The event itself, as the newest entry of its own timeline. */
function thisEvent(event: StoredEvent): Crumb {
  const exception = event.exceptions.at(-1);
  const base = { timestamp: event.timestamp, data: null, virtual: true };

  if (exception === undefined) {
    const message = event.message?.formatted ?? event.message?.message ?? event.title;

    return { ...base, type: "info", category: "message", level: "info", message };
  }

  return {
    ...base,
    type: "error",
    category: exception.module ?? "exception",
    level: event.level,
    message: `${exception.type ?? "Error"}: ${exception.value ?? ""}`,
  };
}

function matches(crumb: Crumb, search: string): boolean {
  const text = `${crumb.category ?? ""} ${crumb.message ?? ""} ${crumb.data === null ? "" : jsonText(crumb.data)}`;

  return text.toLowerCase().includes(search.toLowerCase());
}

const TIMES = ["absolute", "relative"] as const;

export function Breadcrumbs({ event }: { event: StoredEvent }): JSX.Element | null {
  const [expanded, setExpanded] = useState(false);
  const [search, setSearch] = useState("");
  const [times, setTimes] = useChoice("crumb-times", TIMES);

  if (event.breadcrumbs.length === 0) {
    return null;
  }

  const all = [thisEvent(event), ...event.breadcrumbs.toReversed()].filter((crumb) =>
    matches(crumb, search),
  );

  const limit = all.length === SUMMARY + 2 ? all.length : SUMMARY + 1;
  const shown = expanded || search !== "" ? all : all.slice(0, limit);

  const time = (crumb: Crumb): string =>
    times === "relative"
      ? relative(crumb, event.timestamp)
      : crumb.timestamp === null
        ? ""
        : clockTime(crumb.timestamp);

  const actions = (
    <>
      <input
        type="search"
        className="small-search"
        aria-label="Filter breadcrumbs"
        placeholder="Filter breadcrumbs…"
        value={search}
        onChange={(change) => setSearch(change.target.value)}
      />
      <Segmented
        label="Time format"
        options={[
          ["absolute", "Absolute"],
          ["relative", "Relative"],
        ]}
        value={times}
        onChange={setTimes}
      />
    </>
  );

  return (
    <Section id="breadcrumbs" title="Breadcrumbs" actions={actions}>
      <div className="crumbs">
        {numbered(shown).map(([position, crumb]) => (
          <Breadcrumb key={position} crumb={crumb} time={time(crumb)} />
        ))}
        {shown.length === 0 && <div className="muted small">No breadcrumbs match.</div>}
      </div>
      {shown.length < all.length && (
        <button type="button" className="small view-more" onClick={() => setExpanded(true)}>
          View {all.length - shown.length} more
        </button>
      )}
    </Section>
  );
}
