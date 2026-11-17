// The body of an event, in Sentry's order: highlights, message, stack trace,
// breadcrumbs, request, tags, contexts, extra data, SDK and grouping.

import type { JsonObject, StoredEvent } from "@contract";
import { useState } from "react";
import type { JSX } from "react";

import { KeyValueTable } from "~/components/json-view";
import { CopyButton } from "~/components/overlays";
import { Section, Segmented } from "~/components/section";
import { Linkified } from "~/components/text";

import { Breadcrumbs } from "./breadcrumbs";
import { ContextsSection } from "./event-contexts";
import { RequestSection } from "./event-request";
import { TagsSection } from "./event-tags";
import { StackTraceSection } from "./stack-trace";

function handledText(event: StoredEvent): string | null {
  const handled = event.exceptions.at(-1)?.mechanism?.handled ?? null;

  if (handled === null) {
    return null;
  }

  return handled ? "yes" : "no";
}

function Highlights({ event }: { event: StoredEvent }): JSX.Element {
  const left: JsonObject = {};
  const right: JsonObject = {};

  left["handled"] = handledText(event);
  left["level"] = event.level;
  left["transaction"] = event.transaction;
  right["url"] = event.request?.url ?? null;
  right["release"] = event.release;
  right["environment"] = event.environment;

  return (
    <Section id="highlights" title="Highlights">
      <div className="columns">
        <KeyValueTable data={left} />
        <KeyValueTable data={right} />
      </div>
    </Section>
  );
}

function messageOf(event: StoredEvent): string | null {
  return event.message?.formatted ?? event.message?.message ?? null;
}

function sorted(data: JsonObject): JsonObject {
  return Object.fromEntries(
    Object.entries(data).toSorted(([left], [right]) => left.localeCompare(right)),
  );
}

function ExtraData({ extra }: { extra: JsonObject }): JSX.Element {
  const [view, setView] = useState<"formatted" | "raw">("formatted");
  const raw = JSON.stringify(sorted(extra), null, 2);

  const actions = (
    <>
      <Segmented
        label="Additional data view"
        options={[
          ["formatted", "Formatted"],
          ["raw", "Raw"],
        ]}
        value={view}
        onChange={setView}
      />
      <CopyButton text={raw} message="Copied the additional data" />
    </>
  );

  return (
    <Section id="extra" title="Additional Data" actions={actions}>
      {view === "raw" ? (
        <pre className="raw-trace">{raw}</pre>
      ) : (
        <KeyValueTable data={sorted(extra)} />
      )}
    </Section>
  );
}

function Sdk({ event }: { event: StoredEvent }): JSX.Element | null {
  if (event.sdk === null) {
    return null;
  }

  const data: JsonObject = {};

  data["Name"] = event.sdk.name;
  data["Version"] = event.sdk.version;

  return (
    <Section id="sdk" title="SDK" folded>
      <KeyValueTable data={data} />
    </Section>
  );
}

function Grouping({ event }: { event: StoredEvent }): JSX.Element {
  const custom =
    event.fingerprint !== null &&
    event.fingerprint.some((part) => !/^\{\{\s*default\s*\}\}$/.test(part));

  const basis = event.exceptions.some((exception) => exception.frames.length > 0)
    ? "stack trace"
    : event.exceptions.length > 0
      ? "exception"
      : "message";

  return (
    <Section id="grouping" title="Event Grouping Information" folded>
      <div className="grouping">
        Grouped by: <strong>{custom ? "custom fingerprint" : `${basis} (default grouping)`}</strong>
      </div>
      {event.fingerprint !== null && (
        <div className="mono fingerprint">
          {event.fingerprint.map((part) => JSON.stringify(part)).join(", ")}
        </div>
      )}
    </Section>
  );
}

/** The sections this event has, in page order, for the "Jump to" links. */
export function sectionList(event: StoredEvent): [id: string, label: string][] {
  const present: [id: string, label: string, shown: boolean][] = [
    ["highlights", "Highlights", true],
    ["message", "Message", messageOf(event) !== null],
    ["stack-trace", "Stack Trace", event.exceptions.length > 0],
    ["breadcrumbs", "Breadcrumbs", event.breadcrumbs.length > 0],
    ["request", "HTTP Request", event.request !== null],
    ["tags", "Tags", true],
    ["contexts", "Contexts", event.user !== null || Object.keys(event.contexts).length > 0],
    ["extra", "Additional Data", Object.keys(event.extra).length > 0],
  ];

  return present.flatMap(([id, label, shown]): [string, string][] => (shown ? [[id, label]] : []));
}

export function EventSections({ org, event }: { org: string; event: StoredEvent }): JSX.Element {
  const message = messageOf(event);

  return (
    <>
      <Highlights event={event} />
      {message !== null && (
        <Section id="message" title="Message">
          <pre className="message">
            <Linkified text={message} />
          </pre>
        </Section>
      )}
      {event.exceptions.length > 0 && <StackTraceSection event={event} />}
      <Breadcrumbs event={event} />
      {event.request !== null && <RequestSection request={event.request} />}
      <TagsSection org={org} event={event} />
      <ContextsSection event={event} />
      {Object.keys(event.extra).length > 0 && <ExtraData extra={event.extra} />}
      <Sdk event={event} />
      <Grouping event={event} />
    </>
  );
}
